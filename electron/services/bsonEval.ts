import {
  BSON,
  Binary,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID
} from 'mongodb';

/** The driver re-exports BSON rather than EJSON directly. */
export const EJSON = BSON.EJSON;

/**
 * BSON types are ES classes, but the shell lets you write `ObjectId("…")`
 * without `new`. This wrapper accepts both forms and keeps the class's static
 * methods (`Long.fromString`, `UUID.generate`, …) reachable through the
 * prototype chain.
 */
function callable<T extends new (...args: never[]) => unknown>(Ctor: T): T {
  const wrapper = function (...args: unknown[]) {
    return new (Ctor as unknown as new (...args: unknown[]) => unknown)(...args);
  };
  Object.setPrototypeOf(wrapper, Ctor);
  wrapper.prototype = Ctor.prototype;
  return wrapper as unknown as T;
}

/**
 * mongosh-style constructors made available to anything the user types
 * (queries, export filters, sort/projection specs).
 */
export function buildHelpers(): Record<string, unknown> {
  const ObjectIdHelper = callable(ObjectId);
  return {
    ObjectId: ObjectIdHelper,
    ObjectID: ObjectIdHelper,
    UUID: callable(UUID),
    Binary: callable(Binary),
    Code: callable(Code),
    DBRef: callable(DBRef),
    Timestamp: callable(Timestamp),
    MinKey: callable(MinKey),
    MaxKey: callable(MaxKey),
    EJSON,
    ISODate: (value?: string) => (value ? new Date(value) : new Date()),
    NumberInt: (value: number | string) => new Int32(Number(value)),
    NumberLong: (value: number | string) => Long.fromString(String(value)),
    NumberDecimal: (value: number | string) => Decimal128.fromString(String(value)),
    NumberDouble: (value: number | string) => new Double(Number(value)),
    BinData: (subType: number, base64: string) => new Binary(Buffer.from(base64, 'base64'), subType),
    Decimal128: callable(Decimal128),
    Int32: callable(Int32),
    Long: callable(Long),
    Double: callable(Double)
  };
}

/** Node globals a user-supplied snippet should not be able to reach. */
export const SHADOWED_GLOBALS: Record<string, undefined> = {
  require: undefined,
  process: undefined,
  module: undefined,
  exports: undefined,
  global: undefined,
  globalThis: undefined,
  __dirname: undefined,
  __filename: undefined
};

/**
 * Evaluates a single expression such as `{ status: "active" }` or
 * `{ _id: ObjectId("...") }` into a real BSON-capable object.
 */
export function evaluateExpression<T = Record<string, unknown>>(
  source: string | undefined,
  label: string
): T | undefined {
  const trimmed = (source ?? '').trim();
  if (!trimmed) return undefined;
  const scope = { ...buildHelpers(), ...SHADOWED_GLOBALS };
  const names = Object.keys(scope);
  try {
    const fn = new Function(...names, `"use strict";\nreturn (\n${trimmed}\n);`);
    const value = fn(...names.map((name) => scope[name]));
    if (value === null || typeof value !== 'object') {
      throw new Error('expected an object');
    }
    return value as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label}: ${message}`);
  }
}
