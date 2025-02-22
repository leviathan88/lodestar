import {readOnlyMap} from "@chainsafe/ssz";
import {phase0} from "@chainsafe/lodestar-types";
import {ISignatureSet} from "./types";
import {EpochContext} from "../util";
import {getIndexedAttestationSignatureSet} from "../block/isValidIndexedAttestation";

export function getAttesterSlashingsSignatureSets(
  epochCtx: EpochContext,
  state: phase0.BeaconState,
  signedBlock: phase0.SignedBeaconBlock
): ISignatureSet[] {
  return readOnlyMap(signedBlock.message.body.attesterSlashings, (attesterSlashing) =>
    [attesterSlashing.attestation1, attesterSlashing.attestation2].map((attestation) =>
      getIndexedAttestationSignatureSet(epochCtx, state, attestation)
    )
  ).flat(1);
}
