// src/validation/ajv.ts
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

// Adjust paths if your schemas dir differs
import challengeSchema from "../../schemas/challenge.schema.json";
import receiptSchema from "../../schemas/receipt.schema.json";

// Ajv for JSON Schema 2020-12
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});

addFormats(ajv);

export function compileChallengeValidator() {
  return ajv.compile(challengeSchema);
}

export function compileReceiptValidator() {
  return ajv.compile(receiptSchema);
}
