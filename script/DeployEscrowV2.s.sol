// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {AgentPassport} from "../src/AgentPassport.sol";
import {JobEscrow} from "../src/JobEscrow.sol";

/// @title DeployEscrowV2 — JobEscrow v2 next to the live AgentPassport (Monad testnet)
/// @notice The security review (docs/SECURITY.md) changed only JobEscrow. The passport keeps its
///         address and its history; the passport owner deploys the new escrow and allows it as an
///         attester. JobEscrow v1 stays an attester on purpose: disallowing it would make release /
///         refund revert for any job someone opens on it later, trapping that hirer's USDC.
///
///   forge script script/DeployEscrowV2.s.sol:DeployEscrowV2 --rpc-url monad_testnet            # dry run
///   forge script script/DeployEscrowV2.s.sol:DeployEscrowV2 --rpc-url monad_testnet --broadcast
///
/// DEPLOYER_PRIVATE_KEY must be the passport owner. deploy/addresses.json is rewritten only on
/// broadcast: JobEscrow -> v2, the old address kept as JobEscrowV1.
contract DeployEscrowV2 is Script {
    string internal constant NET = ".monad-testnet";

    function run() external {
        string memory addrPath = string.concat(vm.projectRoot(), "/deploy/addresses.json");
        string memory cfgPath = string.concat(vm.projectRoot(), "/deploy/monad-testnet.json");
        string memory addrs = vm.readFile(addrPath);
        string memory cfg = vm.readFile(cfgPath);
        require(block.chainid == vm.parseJsonUint(cfg, ".chainId"), "wrong chain: expected Monad testnet 10143");

        AgentPassport passport = AgentPassport(vm.parseJsonAddress(addrs, string.concat(NET, ".AgentPassport")));
        address v1 = vm.parseJsonAddress(addrs, string.concat(NET, ".JobEscrow"));
        address identity = vm.parseJsonAddress(cfg, ".erc8004.identityRegistry");
        address usdc = vm.parseJsonAddress(cfg, ".tokens.usdc");
        require(passport.identityRegistry() == identity, "passport / config identity registry mismatch");

        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        require(vm.addr(key) == passport.owner(), "DEPLOYER_PRIVATE_KEY is not the passport owner");

        vm.startBroadcast(key);
        JobEscrow v2 = new JobEscrow(identity, address(passport), usdc);
        passport.setAttester(address(v2), true);
        vm.stopBroadcast();

        require(passport.isAttester(address(v2)), "v2 not allowed");
        console.log("AgentPassport (unchanged):", address(passport));
        console.log("JobEscrow v1 (kept as attester):", v1);
        console.log("JobEscrow v2:", address(v2));

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            _record(addrPath, addrs, address(v2), v1);
            console.log("Recorded in deploy/addresses.json");
        } else {
            console.log("Dry run: deploy/addresses.json not modified");
        }
    }

    function _record(string memory path, string memory addrs, address v2, address v1) internal {
        string memory o = "monad-testnet";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "AgentPassport", vm.parseJsonAddress(addrs, string.concat(NET, ".AgentPassport")));
        vm.serializeAddress(o, "deployer", vm.parseJsonAddress(addrs, string.concat(NET, ".deployer")));
        vm.serializeUint(o, "deployedAtBlock", vm.parseJsonUint(addrs, string.concat(NET, ".deployedAtBlock")));
        vm.serializeUint(o, "deployedAt", vm.parseJsonUint(addrs, string.concat(NET, ".deployedAt")));
        vm.serializeAddress(o, "JobEscrowV1", v1);
        vm.serializeAddress(o, "JobEscrow", v2);
        vm.serializeUint(o, "jobEscrowDeployedAtBlock", block.number);
        string memory inner = vm.serializeUint(o, "jobEscrowDeployedAt", block.timestamp);
        vm.writeJson(vm.serializeString("root", "monad-testnet", inner), path);
    }
}
