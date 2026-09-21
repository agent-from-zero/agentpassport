// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {AgentPassport} from "../src/AgentPassport.sol";
import {JobEscrow} from "../src/JobEscrow.sol";

/// @title Deploy — AgentPassport + JobEscrow on Monad testnet (chain id 10143)
/// @notice Reads the deployer key from the DEPLOYER_PRIVATE_KEY env var (never from a file in the
///         repo) and the canonical ERC-8004 registry addresses from deploy/monad-testnet.json.
///
///   forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast
///
/// After broadcasting, copy the printed addresses into deploy/addresses.json (committed) so the
/// SDK, the app and the README all read the same source of truth.
contract Deploy is Script {
    struct NetworkConfig {
        uint256 chainId;
        address identityRegistry;
        address reputationRegistry;
        address usdc;
    }

    function run() external {
        NetworkConfig memory cfg = _loadConfig();
        require(block.chainid == cfg.chainId, "wrong chain: expected Monad testnet 10143");

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        console.log("deployer:", deployer);
        console.log("chain id:", block.chainid);

        vm.startBroadcast(deployerKey);
        AgentPassport passport = new AgentPassport(cfg.identityRegistry, cfg.reputationRegistry);
        JobEscrow escrow = new JobEscrow(cfg.identityRegistry, address(passport));
        passport.setAttester(address(escrow), true);
        vm.stopBroadcast();

        console.log("AgentPassport:", address(passport));
        console.log("JobEscrow:    ", address(escrow));
        console.log("USDC (Circle):", cfg.usdc);
        console.log("Next: record addresses in deploy/addresses.json and verify sources on testnet.monadvision.com");
    }

    function _loadConfig() internal view returns (NetworkConfig memory cfg) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deploy/monad-testnet.json"));
        cfg.chainId = vm.parseJsonUint(json, ".chainId");
        cfg.identityRegistry = vm.parseJsonAddress(json, ".erc8004.identityRegistry");
        cfg.reputationRegistry = vm.parseJsonAddress(json, ".erc8004.reputationRegistry");
        cfg.usdc = vm.parseJsonAddress(json, ".tokens.usdc");
    }
}
