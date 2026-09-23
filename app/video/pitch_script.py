"""The pitch video's script (2 minutes max): one entry per slide in pitch/slides.html, in order.
`python pitch_script.py` writes docs/PITCH_SCRIPT.md from it. Every number here was checked on chain
(cast) on 2026-09-23 after job #5; update it if the numbers move.
"""
from __future__ import annotations

from pathlib import Path

SLIDES = [
    {
        "id": "team",
        "title": "Team",
        "text": "Hi, this is AgentPassport. The team is one autonomous AI agent, agentfromzero, built on Claude, working for a human principal on a zero-dollar budget. The agent built everything you see, and this voice is synthetic.",
    },
    {
        "id": "problem",
        "title": "Problem",
        "text": "AI agents are starting to pay each other. ERC-8004 gives them identities and a reputation registry, but anyone can post feedback. One agent on Monad testnet has twenty-five entries and not one paid job.",
    },
    {
        "id": "solution",
        "title": "What we built",
        "text": "AgentPassport ties reputation to money. A hirer locks USDC in escrow, the agent commits the hash of its result, and only a release stamps the agent's passport and the ERC-8004 registry. Then anyone can ask on chain: does this agent meet my policy?",
    },
    {
        "id": "monad",
        "title": "Why Monad",
        "text": "Why Monad? A trust check must be fast enough to run before every job. Here a hire or a release is final in about a second, ERC-8004, USDC and x402 are already live, and the P256 precompile enables passkey releases.",
    },
    {
        "id": "works",
        "title": "What works today",
        "text": "It all runs today: verified contracts, five escrow jobs with four settled, one released by a Dynamic server wallet, an SDK on npm, a paid x402 API, an Envio and Nansen trust index, an autonomous worker, and this dashboard.",
    },
    {
        "id": "traction",
        "title": "Traction, honestly",
        "text": "Traction is early, and we say it plainly: every job and paid call so far comes from wallets run by our own operator. Public today: passports for all thirteen ERC-8004 agents on Monad testnet. No outside hirer yet.",
    },
    {
        "id": "next",
        "title": "What's next",
        "text": "Next: a policy check inside x402 payments, a worker kit so any agent can take escrow jobs, independent dispute verifiers, and mainnet. AgentPassport: trust for AI agents, backed by money that actually moved.",
    },
]


def write_markdown(out: Path) -> None:
    rows = [
        "# Pitch video script (AgentPassport, 2 minutes max)",
        "",
        "Generated from `app/video/pitch_script.py`. The slides are `app/video/pitch/slides.html`, rendered to "
        "1280x720 PNGs with Playwright. The narration is synthetic (edge-tts), and the first slide says that the "
        "team is one AI agent and that the voice is AI-generated.",
        "",
    ]
    for i, s in enumerate(SLIDES, 1):
        rows += [f"## {i}. {s['title']}", "", f"> {s['text']}", ""]
    out.write_text("\n".join(rows), encoding="utf8")


if __name__ == "__main__":
    target = Path(__file__).resolve().parents[2] / "docs" / "PITCH_SCRIPT.md"
    write_markdown(target)
    print("wrote", target)
