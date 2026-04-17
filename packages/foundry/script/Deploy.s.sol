//SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./DeployHelpers.s.sol";
import { DeployUpDown } from "./DeployUpDown.s.sol";

/**
 * @notice Main deployment script for all contracts
 * @dev Run this when you want to deploy multiple contracts at once
 *
 * Example: yarn deploy # runs this script(without`--file` flag)
 */
contract DeployScript is ScaffoldETHDeploy {
  function run() external {
    // Deploy UpDown — the core game contract for LeftClaw job #65.
    DeployUpDown deployUpDown = new DeployUpDown();
    deployUpDown.run();
  }
}