import {join} from "path";
import {expect} from "chai";
import {config} from "@chainsafe/lodestar-config/minimal";
import {describeDirectorySpecTest} from "@chainsafe/lodestar-spec-test-util";
import {IProcessBlockHeader} from "./type";
import {phase0} from "@chainsafe/lodestar-beacon-state-transition";
import {SPEC_TEST_LOCATION} from "../../../utils/specTestCases";

describeDirectorySpecTest<IProcessBlockHeader, phase0.BeaconState>(
  "process block header minimal",
  join(SPEC_TEST_LOCATION, "/tests/minimal/phase0/operations/block_header/pyspec_tests"),
  (testcase) => {
    const state = testcase.pre;
    phase0.processBlockHeader(config, state, testcase.block);
    return state;
  },
  {
    sszTypes: {
      pre: config.types.phase0.BeaconState,
      post: config.types.phase0.BeaconState,
      block: config.types.phase0.BeaconBlock,
    },
    timeout: 100000000,
    shouldError: (testCase) => !testCase.post,
    getExpected: (testCase) => testCase.post,
    expectFunc: (testCase, expected, actual) => {
      expect(config.types.phase0.BeaconState.equals(actual, expected)).to.be.true;
    },
  }
);
