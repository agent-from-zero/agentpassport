// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {AgentPassport} from "../src/AgentPassport.sol";
import {JobEscrow} from "../src/JobEscrow.sol";

/// @title Deploy — AgentPassport + JobEscrow on Monad testnet (chain id 10143)
/// @notice Reads the deployer key from the DEPLOYER_PRIVATE_KEY env var (never from a file in the
///         repo) and the canonical ERC-8004 registry + USDC addresses from deploy/monad-testnet.json.
///
///   forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast
///
/// Without --broadcast it is a dry run (simulated against the live chain; nothing is sent and
/// deploy/addresses.json is left alone). On broadcast the script writes the new addresses into deploy/addresses.json (committed), which
/// the SDK, the app and the README read as the single source of truth. Tx hashes are in
/// broadcast/Deploy.s.sol/10143/run-latest.json.
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
        JobEscrow escrow = new JobEscrow(cfg.identityRegistry, address(passport), cfg.usdc);
        passport.setAttester(address(escrow), true);
        vm.stopBroadcast();

        console.log("AgentPassport:", address(passport));
        console.log("JobEscrow:    ", address(escrow));
        console.log("USDC (Circle):", cfg.usdc);

        // Only a real broadcast may overwrite the committed addresses; a dry run just prints them.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            _record(address(passport), address(escrow), deployer);
            console.log("Recorded in deploy/addresses.json; verify sources next (see deploy/README.md).");
        } else {
            console.log("Dry run: deploy/addresses.json not modified.");
        }
    }

    function _loadConfig() internal view returns (NetworkConfig memory cfg) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deploy/monad-testnet.json"));
        cfg.chainId = vm.parseJsonUint(json, ".chainId");
        cfg.identityRegistry = vm.parseJsonAddress(json, ".erc8004.identityRegistry");
        cfg.reputationRegistry = vm.parseJsonAddress(json, ".erc8004.reputationRegistry");
        cfg.usdc = vm.parseJsonAddress(json, ".tokens.usdc");
    }

    function _record(address passport, address escrow, address deployer) internal {
        string memory path = string.concat(vm.projectRoot(), "/deploy/addresses.json");
        string memory obj = "monad-testnet";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "AgentPassport", passport);
        vm.serializeAddress(obj, "JobEscrow", escrow);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeUint(obj, "deployedAtBlock", block.number);
        string memory inner = vm.serializeUint(obj, "deployedAt", block.timestamp);
        string memory outer = vm.serializeString("root", "monad-testnet", inner);
        vm.writeJson(outer, path);
    }
}
