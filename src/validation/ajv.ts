// src/validation/ajv.ts
import Ajv from "ajv";
import addFormats from "ajv-formats";
// Adjust paths if your schemas dir differs
import challengeSchema from "../../schemas/challenge.schema.json";
import receiptSchema from "../../schemas/receipt.schema.json";

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

export function compileChallengeValidator() {
  return ajv.compile(challengeSchema);
}
export function compileReceiptValidator() {
  return ajv.compile(receiptSchema);
}
