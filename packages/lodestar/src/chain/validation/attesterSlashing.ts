import {isValidAttesterSlashing} from "@chainsafe/lodestar-beacon-state-transition/";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {phase0, ValidatorIndex} from "@chainsafe/lodestar-types";
import {IBeaconChain} from "..";
import {AttesterSlashingError, AttesterSlashingErrorCode} from "../errors/attesterSlashingError";
import {IBeaconDb} from "../../db";
import {arrayIntersection, sszEqualPredicate} from "../../util/objects";

export async function validateGossipAttesterSlashing(
  config: IBeaconConfig,
  chain: IBeaconChain,
  db: IBeaconDb,
  attesterSlashing: phase0.AttesterSlashing
): Promise<void> {
  const attesterSlashedIndices = arrayIntersection<ValidatorIndex>(
    attesterSlashing.attestation1.attestingIndices.valueOf() as ValidatorIndex[],
    attesterSlashing.attestation2.attestingIndices.valueOf() as ValidatorIndex[],
    sszEqualPredicate(config.types.ValidatorIndex)
  );

  if (await db.attesterSlashing.hasAll(attesterSlashedIndices)) {
    throw new AttesterSlashingError({
      code: AttesterSlashingErrorCode.SLASHING_ALREADY_EXISTS,
    });
  }

  const state = chain.getHeadState();
  if (!isValidAttesterSlashing(config, state, attesterSlashing)) {
    throw new AttesterSlashingError({
      code: AttesterSlashingErrorCode.INVALID_SLASHING,
    });
  }
}
