import { types as t } from '@babel/core';
import { NodePath } from '@babel/traverse';

type InferArray<T> = T extends Array<infer A> ? A : never;

type Parameter = InferArray<t.ClassMethod['params']> | t.ClassProperty;

function createSimpleKind(kind: string) {
  return t.objectExpression([
    t.objectProperty(t.identifier('kind'), t.stringLiteral(kind)),
  ]);
}

function createVoidZero() {
  return t.unaryExpression('void', t.numericLiteral(0));
}

/**
 * Given a paramater (or class property) node it returns the first identifier
 * containing the TS Type Annotation.
 *
 * @todo Array and Objects spread are not supported.
 * @todo Rest parameters are not supported.
 */
function getTypedNode(param: Parameter | null): t.Identifier | t.ClassProperty | null {
  if (param == null) return null;

  if (param.type === 'ClassProperty') return param;
  if (param.type === 'Identifier') return param;

  if (param.type === 'AssignmentPattern' && param.left.type === 'Identifier')
    return param.left;

  if (param.type === 'TSParameterProperty')
    return getTypedNode(param.parameter);

  return null;
}

export function serializeType(
  classPath: NodePath<t.ClassDeclaration>,
  param: Parameter | null
) {
  const node = getTypedNode(param);
  if (node == null) return createVoidZero();

  if (!node.typeAnnotation || node.typeAnnotation.type !== 'TSTypeAnnotation')
    return createVoidZero();

  const annotation = node.typeAnnotation.typeAnnotation;
  const className = classPath.node.id ? classPath.node.id.name : '';
  return serializeTypeNode(className, annotation);
}

function serializeTypeReferenceNode(
  className: string,
  node: t.TSTypeReference
) {
  /**
   * We need to save references to this type since it is going
   * to be used as a Value (and not just as a Type) here.
   *
   * This is resolved in main plugin method, calling
   * `path.scope.crawl()` which updates the bindings.
   */
  const reference = serializeReference(node.typeName);

  /**
   * We should omit references to self (class) since it will throw a
   * ReferenceError at runtime due to babel transpile output.
   */
  if (isClassType(className, reference)) {
    return createSimpleKind('object');
  }

  /**
   * We don't know if type is just a type (interface, etc.) or a concrete
   * value (class, etc.).
   * `typeof` operator allows us to use the expression even if it is not
   * defined, fallback is just `Object`.
   */
  const safeReference = t.conditionalExpression(
    t.binaryExpression(
      '===',
      t.unaryExpression('typeof', reference),
      t.stringLiteral('undefined')
    ),
    t.identifier('Object'),
    t.cloneDeep(reference)
  );

  return t.objectExpression([
    t.objectProperty(t.identifier('kind'), t.stringLiteral('reference')),
    t.objectProperty(t.identifier('type'), safeReference),
    t.objectProperty(t.identifier('arguments'), t.arrayExpression(
      node.typeParameters?.params?.map(p => serializeTypeNode(className, p)) ?? []
    ))
  ]);
}

/**
 * Checks if node (this should be the result of `serializeReference`) member
 * expression or identifier is a reference to self (class name).
 * In this case, we just emit `Object` in order to avoid ReferenceError.
 */
export function isClassType(className: string, node: t.Expression): boolean {
  switch (node.type) {
    case 'Identifier':
      return node.name === className;

    case 'MemberExpression':
      return isClassType(className, node.object);

    default:
      throw new Error(
        `The property expression at ${node.start} is not valid as a Type to be used in Reflect.metadata`
      );
  }
}

function serializeReference(
  typeName: t.Identifier | t.TSQualifiedName
): t.Identifier | t.MemberExpression {
  if (typeName.type === 'Identifier') {
    return t.identifier(typeName.name);
  }
  return t.memberExpression(serializeReference(typeName.left), typeName.right);
}

type SerializedType = t.Expression;

function serializeTupleElement(className: string, type: t.TSType | t.TSNamedTupleMember): t.Expression {
  if (type.type === 'TSNamedTupleMember') {
    return serializeTypeNode(className, type.elementType);
  } else {
    return serializeTypeNode(className, type);
  }
}

/**
 * Actual serialization given the TS Type annotation.
 * Result tries to get the best match given the information available.
 *
 * Implementation is adapted from original TSC compiler source as
 * available here:
 *  https://github.com/Microsoft/TypeScript/blob/2932421370df720f0ccfea63aaf628e32e881429/src/compiler/transformers/ts.ts
 */
function serializeTypeNode(className: string, node: t.TSType): SerializedType {
  if (node === undefined) {
    return createSimpleKind('object');
  }

  switch (node.type) {
    case 'TSVoidKeyword':
    case 'TSNeverKeyword':
      return createSimpleKind('void');

    case 'TSUndefinedKeyword':
      return createSimpleKind('undefined');

    case 'TSNullKeyword':
      return createSimpleKind('null');

    case 'TSParenthesizedType':
      return serializeTypeNode(className, node.typeAnnotation);

    case 'TSFunctionType':
    case 'TSConstructorType':
      return createSimpleKind('function');

    case 'TSArrayType':
      return t.objectExpression([
        t.objectProperty(t.identifier('kind'), t.stringLiteral('reference')),
        t.objectProperty(t.identifier('type'), t.identifier('Array')),
        t.objectProperty(t.identifier('arguments'), t.arrayExpression([
          serializeTypeNode(className, node.elementType)
        ]))
      ]);

    case 'TSTupleType':
      return t.objectExpression([
        t.objectProperty(t.identifier('kind'), t.stringLiteral('tuple')),
        t.objectProperty(t.identifier('elements'), t.arrayExpression(
          node.elementTypes.map(t => serializeTupleElement(className, t))
        ))
      ]);

    case 'TSTypePredicate':
    case 'TSBooleanKeyword':
      return createSimpleKind('boolean');

    case 'TSStringKeyword':
      return createSimpleKind('string');

    case 'TSObjectKeyword':
      return createSimpleKind('object');

    case 'TSLiteralType':
      return t.objectExpression([
        t.objectProperty(t.identifier('kind'), t.stringLiteral('literal')),
        t.objectProperty(t.identifier('value'), node.literal),
      ]);

    case 'TSNumberKeyword':
    case 'TSBigIntKeyword':
      return createSimpleKind('number');

    case 'TSSymbolKeyword':
      return createSimpleKind('symbol');

    case 'TSTypeReference':
      return serializeTypeReferenceNode(className, node);

    case 'TSIntersectionType':
    case 'TSUnionType':
      return serializeTypeList(className, node.types);

    case 'TSConditionalType':
      return serializeTypeList(className, [node.trueType, node.falseType]);

    default:
      return createSimpleKind('object');
  }
}

/**
 * Type lists need some refining. Even here, implementation is slightly
 * adapted from original TSC compiler:
 *
 *  https://github.com/Microsoft/TypeScript/blob/2932421370df720f0ccfea63aaf628e32e881429/src/compiler/transformers/ts.ts
 */
function serializeTypeList(
  className: string,
  types: ReadonlyArray<t.TSType>
): SerializedType {
  return t.objectExpression([
    t.objectProperty(t.identifier('kind'), t.stringLiteral('union')),
    t.objectProperty(t.identifier('types'), t.arrayExpression(
      types.map(t => serializeTypeNode(className, t)),
    )),
  ]);
}
