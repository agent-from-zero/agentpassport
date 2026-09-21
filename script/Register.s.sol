// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IIdentityRegistry} from "../src/interfaces/IERC8004.sol";

/// @title Register — mint agentfromzero's ERC-8004 identity on Monad testnet
/// @notice The agent's owner key is AGENT_PRIVATE_KEY (env). The canonical registry sets
///         `agentWallet = msg.sender` on register, so payments go to the same key unless changed.
///
///   AGENT_URI=https://agentfromzero.netlify.app/.well-known/agent-card.json \
///   forge script script/Register.s.sol:Register --rpc-url monad_testnet --broadcast
///
/// The agentId is emitted in the registry's `Registered` event (read it from the receipt in
/// broadcast/Register.s.sol/10143/run-latest.json; the simulated return value can drift if someone
/// else registers between simulation and inclusion).
contract Register is Script {
    function run() external {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deploy/monad-testnet.json"));
        IIdentityRegistry id = IIdentityRegistry(vm.parseJsonAddress(json, ".erc8004.identityRegistry"));
        require(block.chainid == vm.parseJsonUint(json, ".chainId"), "wrong chain");

        uint256 key = vm.envUint("AGENT_PRIVATE_KEY");
        string memory uri = vm.envString("AGENT_URI");
        console.log("owner:", vm.addr(key));
        console.log("uri:  ", uri);

        vm.startBroadcast(key);
        uint256 agentId = id.register(uri);
        vm.stopBroadcast();

        console.log("agentId (simulated; confirm from the Registered event):", agentId);
        console.log("ownerOf:", id.ownerOf(agentId));
        console.log("agentWallet:", id.getAgentWallet(agentId));
    }
}
