// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./DeployHelpers.s.sol";
import { UpDown } from "../contracts/UpDown.sol";

/// @notice Deploy script for UpDown.sol on Base mainnet.
/// @dev All external addresses are passed as constructor args so the same code
///      compiles/deploys elsewhere if needed. Owner = LeftClaw job #65 client.
contract DeployUpDown is ScaffoldETHDeploy {
    // ---- Base mainnet infrastructure addresses (public, non-secret) ----

    // Job client wallet — becomes the owner of the deployed contract.
    address constant OWNER = 0x7E6Db18aea6b54109f4E5F34242d4A8786E0C471;

    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant CLAWD = 0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07;
    address constant SWAP_ROUTER_02 = 0x2626664c2603336E57B271c5C0b26F421741e481;

    address constant ETH_USD_FEED = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address constant BTC_USD_FEED = 0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F;

    // Base L2 sequencer uptime feed — used to reject prices observed during/after
    // a sequencer outage. Pass address(0) on non-L2 forks to skip the check.
    address constant SEQUENCER_UPTIME_FEED = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;

    function run() external ScaffoldEthDeployerRunner {
        UpDown upDown = new UpDown(
            OWNER, USDC, SWAP_ROUTER_02, ETH_USD_FEED, BTC_USD_FEED, CLAWD, WETH, SEQUENCER_UPTIME_FEED
        );

        deployments.push(Deployment({ name: "UpDown", addr: address(upDown) }));
    }
}
