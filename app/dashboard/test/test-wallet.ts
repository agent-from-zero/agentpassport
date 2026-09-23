// Test-only EIP-1193 wallet for automated runs of the dashboard (the demo recording and smoke tests).
// NOT part of the deployed site. The recorder injects it with Playwright's addInitScript, after
// setting window.__AP_TEST_WALLET__ = { privateKey, name }. It announces itself over EIP-6963 like
// any browser wallet, signs locally with viem, auto-approves every request, and shows each request
// it signs in a small on-page banner so a viewer can see what the "wallet" did.
import { type Hex, createWalletClient, http, numberToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "@agentfromzero/agentpassport-sdk";

declare global {
  interface Window { __AP_TEST_WALLET__?: { privateKey: Hex; name?: string } }
}

const cfg = window.__AP_TEST_WALLET__;
if (cfg?.privateKey) {
  const account = privateKeyToAccount(cfg.privateKey);
  const rpc = monadTestnet.rpcUrls.default.http[0]!;
  const client = createWalletClient({ account, chain: monadTestnet, transport: http(rpc) });
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const name = cfg.name ?? "Test wallet";

  const banner = (text: string) => {
    const show = () => {
      const el = document.createElement("div");
      el.textContent = `🔑 ${name}: ${text}`;
      el.setAttribute("style", "position:fixed;top:70px;right:18px;z-index:99;background:#2b2250;color:#fff;border:1px solid #8f7bff;border-radius:10px;padding:10px 14px;font:600 14px system-ui;box-shadow:0 8px 30px rgba(0,0,0,.5)");
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 2600);
    };
    if (document.body) show();
    else addEventListener("DOMContentLoaded", show);
  };

  const rpcCall = async (method: string, params: unknown) => {
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? [] }) });
    const j = await res.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
    return j.result;
  };

  const SELECTORS: Record<string, string> = { "0x095ea7b3": "approve USDC", "0x": "transfer" };
  const provider = {
    isAgentPassportTestWallet: true,
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_requestAccounts":
          banner(`connected ${account.address.slice(0, 8)}…`);
          return [account.address];
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return numberToHex(monadTestnet.id);
        case "net_version":
          return String(monadTestnet.id);
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        case "eth_sendTransaction": {
          const tx = (params?.[0] ?? {}) as { to: Hex; data?: Hex; value?: Hex; gas?: Hex };
          const sel = (tx.data ?? "0x").slice(0, 10);
          banner(`signed ${SELECTORS[sel] ?? `call ${sel}`} → ${tx.to.slice(0, 8)}…`);
          return client.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined });
        }
        case "personal_sign":
          banner("signed a message");
          return account.signMessage({ message: { raw: params![0] as Hex } });
        case "eth_signTypedData_v4": {
          banner("signed typed data");
          const td = JSON.parse(params![1] as string);
          delete td.types.EIP712Domain;
          return account.signTypedData(td);
        }
        default:
          return rpcCall(method, params);
      }
    },
    on(ev: string, fn: (...a: unknown[]) => void) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(fn);
    },
    removeListener(ev: string, fn: (...a: unknown[]) => void) {
      listeners.get(ev)?.delete(fn);
    },
  };

  const detail = Object.freeze({
    info: { uuid: "5b0e6d1c-6a51-4f7e-9d7e-2f3a8c1d9e40", name, icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", rdns: "app.agentpassport.testwallet" },
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}
