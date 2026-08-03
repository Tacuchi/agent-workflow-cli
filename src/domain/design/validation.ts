/**
 * The design side of the shared contract machinery.
 *
 * The reader, the closed-object rule and the coverage tracking are generic and
 * live in `../contract-reader.js`; what is design-specific is the failure CODE
 * prefix every diagnostic carries (`DESIGN_FIELD_INVALID`, `DESIGN_KEY_UNKNOWN`).
 * Binding it once here is what lets every design validator keep importing
 * `Reader` from this module unchanged while the capability descriptor — which
 * must not depend on `domain/design` — builds on the same machinery under its
 * own prefix.
 */

import { ContractReader } from "../contract-reader.js";
import type { AllowedKeys, ContractFailure } from "../contract-reader.js";

export type { AllowedKeys } from "../contract-reader.js";
export { eachRecord, isNonEmptyString, isRecord } from "../contract-reader.js";

export type DesignFailure = ContractFailure;

export class Reader extends ContractReader {
  constructor(allowedKeys: AllowedKeys) {
    super("DESIGN", allowedKeys);
  }
}
