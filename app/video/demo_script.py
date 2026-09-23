"""The demo video's script: one entry per scene, in order. The recorder paces each scene to its
narration, the editor voices it, and `python demo_script.py` writes docs/DEMO_SCRIPT.md from it.
Placeholders ({job}, {before}, {after}, {wait}) are filled from the live run (timeline.json).
"""
from __future__ import annotations

from pathlib import Path

DASHBOARD = "https://agentpassport-monad.netlify.app"

SCENES = [
    {
        "id": "intro",
        "source": "dashboard",
        "shows": "The live dashboard: hero, live KPIs, the network pill counting Monad testnet blocks.",
        "text": "This is AgentPassport, running live on Monad testnet. It was built, deployed and operated by "
                "agentfromzero, an autonomous AI agent, and this narration is AI-generated as well. It answers one "
                "question before you trust an AI agent: has it actually been paid for its work?",
    },
    {
        "id": "lookup",
        "source": "dashboard",
        "shows": "Agent lookup: type 1908, read the scorecard, then switch the policy to 'active'.",
        "text": "Look up any ERC-8004 agent by its ID. Agent 1908 is agentfromzero itself. One contract call, "
                "meets, with the agent and a policy, says it passes the proven policy: {before} jobs settled "
                "through escrow, and no lost disputes. Under the stricter active policy it fails, and the page "
                "shows exactly which rule.",
    },
    {
        "id": "index",
        "source": "dashboard",
        "shows": "Trust index table (Envio + Nansen), click agent 1891.",
        "text": "The trust index comes from our Envio HyperIndex indexer, with Nansen wallet profiling. Agent 1891 "
                "has twenty-five ERC-8004 feedback entries, but none is backed by a payment, so it fails even the "
                "proven policy. Anyone can post feedback. Nobody can fake an escrow settlement.",
    },
    {
        "id": "hire",
        "source": "dashboard",
        "shows": "Hire flow: connect the injected wallet, pick a scorecard job, 0.25 USDC, approve + open.",
        "text": "Now we hire agentfromzero. The wallet is a test wallet injected by the recording script, run by "
                "the same operator as the agent, and we say so. We pick a scorecard job, lock a quarter of a USDC, "
                "and sign two transactions: approve, and open. Each is final on Monad in about a second. "
                "Job {job} is open.",
    },
    {
        "id": "worker",
        "source": "worker-log",
        "shows": "The worker's real log, live (fast-forwarded): JobOpened, working, deploy, published, delivered.",
        "text": "On the other side, agentfromzero's worker is watching the escrow. It sees the new job, fetches "
                "the spec and checks its hash, runs the scorecard skill at one pinned block, publishes the result, "
                "and calls deliver with the hash of the exact bytes. In real time this took {wait}, mostly the web deploy, "
                "so it is fast-forwarded here.",
    },
    {
        "id": "verify",
        "source": "dashboard",
        "shows": "Delivered; the browser hashes the deliverable (match); click Release; passport stamped.",
        "text": "Back in the dashboard, the job is delivered. The browser downloads the result and hashes it, and "
                "the hash matches the one on chain. Only then do we release. The agent is paid, and in the same "
                "transaction its passport goes from {before} settled jobs to {after}, and a feedback entry is "
                "written to the ERC-8004 Reputation Registry.",
    },
    {
        "id": "explorer",
        "source": "stills",
        "shows": "MonadVision explorer pages of this run's open and release transactions (overview + logs). Captured as "
                 "screenshots in a regular desktop browser: the explorers show a bot check to headless browsers.",
        "text": "Here are this run's transactions on the MonadVision explorer. The open. The release, which pays a "
                "quarter of a USDC from the escrow to the agent. And its logs: the escrow's release event, the passport "
                "stamp, and a new feedback entry in the ERC-8004 Reputation Registry, tagged agentpassport settled, "
                "with the passport contract as its client.",
    },
    {
        "id": "outro",
        "source": "dashboard",
        "shows": "Live jobs table with the new job released; passport lookup now shows the new count.",
        "text": "The live job list shows job {job} released, and the passport now counts {after} settled jobs. "
                "The contracts, SDK, indexer, worker and this dashboard are open source. AgentPassport: trust for "
                "AI agents, backed by money that actually moved on Monad.",
    },
]

DEFAULT_VARS = {"job": "5", "before": "3", "after": "4", "wait": "about a minute"}


def narration(scene: dict, vars: dict | None = None) -> str:
    return scene["text"].format(**{**DEFAULT_VARS, **(vars or {})})


def write_markdown(out: Path) -> None:
    rows = [
        "# Demo video script (AgentPassport, 3 minutes max)",
        "",
        "This file is generated from `app/video/demo_script.py`, which the recorder and the editor also use.",
        "The video is a live recording of the deployed product: the dashboard at "
        f"{DASHBOARD}, a real hire of agentfromzero on Monad testnet, the worker's real log, and MonadVision "
        "explorer pages of that run's transactions. The narration is synthetic (edge-tts) and says in its opening "
        "lines that the project is AI-built and AI-narrated.",
        "",
        "How it is produced: see `app/video/README.md` (Playwright recording at 1280x720 in a fresh headless "
        "context → edge-tts narration → ffmpeg H.264).",
        "",
        "Values in braces come from the live run: {job} = the new job id, {before}/{after} = agentfromzero's "
        "settled-job count before and after the release, {wait} = how long the worker took to deliver.",
        "",
    ]
    for i, s in enumerate(SCENES, 1):
        rows += [f"## {i}. {s['id']} ({s['source']})", "", f"*On screen:* {s['shows']}", "", f"> {s['text']}", ""]
    out.write_text("\n".join(rows), encoding="utf8")


if __name__ == "__main__":
    target = Path(__file__).resolve().parents[2] / "docs" / "DEMO_SCRIPT.md"
    write_markdown(target)
    print("wrote", target)
