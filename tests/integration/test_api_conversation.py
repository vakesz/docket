"""HTTP conversation + SSE surface: history, streaming, new-thread."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.conftest import MakeItem
from tests.fakes.llm import FakeLlmClient, text_turn, tool_turn
from tests.integration._api_fixtures import (
    AUTH_HEADERS,
    ApiEnv,
    build_api_env,
    build_client,
    parse_sse,
)


@pytest.fixture
def env(tmp_path: Path, make_item: MakeItem) -> Iterator[ApiEnv]:
    e = build_api_env(tmp_path, make_item)
    yield e
    e.conn.close()


@pytest.fixture
def client(env: ApiEnv) -> TestClient:
    return build_client(env)


def test_conversation_history_empty_when_no_thread(client: TestClient) -> None:
    resp = client.get("/items/S-1/conversation", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["conversation"] is None
    assert body["messages"] == []


def test_conversation_requires_llm(client: TestClient) -> None:
    resp = client.post(
        "/items/S-1/conversation/messages",
        headers=AUTH_HEADERS,
        json={"text": "hi"},
    )
    assert resp.status_code == 503


def test_sse_streams_delta_and_done(env: ApiEnv) -> None:
    llm = FakeLlmClient(script=[text_turn("hello world")])
    client = build_client(env, llm=llm)

    with client.stream(
        "POST",
        "/items/S-1/conversation/messages",
        headers=AUTH_HEADERS,
        json={"text": "summarize"},
    ) as resp:
        assert resp.status_code == 200
        events = parse_sse(resp.iter_lines())

    event_types = [e["event"] for e in events]
    assert event_types.count("delta") > 0
    assert "done" in event_types
    # Concatenated delta text should reconstruct the reply.
    text = "".join(json.loads(e["data"])["text"] for e in events if e["event"] == "delta")
    assert text == "hello world"


def test_sse_emits_proposal_event_when_agent_stages_mutation(env: ApiEnv) -> None:
    # Turn 1: the agent calls propose_transition; turn 2: it replies.
    llm = FakeLlmClient(
        script=[
            tool_turn("tc-1", "propose_transition", '{"id":"S-1","intent":"start_work"}'),
            text_turn("proposed"),
        ]
    )
    client = build_client(env, llm=llm)

    with client.stream(
        "POST",
        "/items/S-1/conversation/messages",
        headers=AUTH_HEADERS,
        json={"text": "start work"},
    ) as resp:
        assert resp.status_code == 200
        events = parse_sse(resp.iter_lines())

    proposals_seen = [e for e in events if e["event"] == "proposal"]
    assert len(proposals_seen) == 1
    payload = json.loads(proposals_seen[0]["data"])
    assert payload["kind"] == "state_change"
    assert payload["item_id"] == "S-1"
    # The proposal is now confirmable via the REST endpoint.
    pid = payload["id"]
    confirm = client.post(f"/items/S-1/mutations/{pid}/confirm", headers=AUTH_HEADERS)
    assert confirm.status_code == 200


def test_new_thread_archives_previous(env: ApiEnv) -> None:
    llm = FakeLlmClient(script=[text_turn("ack")])
    client = build_client(env, llm=llm)

    # Seed a conversation.
    with client.stream(
        "POST",
        "/items/S-1/conversation/messages",
        headers=AUTH_HEADERS,
        json={"text": "hi"},
    ) as r:
        list(r.iter_lines())

    new = client.post("/items/S-1/conversation/thread", headers=AUTH_HEADERS)
    assert new.status_code == 200
    # History is now empty against the new thread.
    history = client.get("/items/S-1/conversation", headers=AUTH_HEADERS).json()
    assert history["messages"] == []


# -- ask_user / SSE question event + /answer endpoint -----------------------


_ASK_ARGS = json.dumps(
    {
        "questions": [
            {
                "question": "Pick one",
                "header": "Pick",
                "options": [
                    {"label": "alpha"},
                    {"label": "beta"},
                ],
            }
        ]
    }
)


def test_sse_emits_question_event_when_agent_calls_ask_user(env: ApiEnv) -> None:
    llm = FakeLlmClient(script=[tool_turn("tc-q1", "ask_user", _ASK_ARGS)])
    client = build_client(env, llm=llm)

    with client.stream(
        "POST",
        "/items/S-1/conversation/messages",
        headers=AUTH_HEADERS,
        json={"text": "should I do X?"},
    ) as resp:
        assert resp.status_code == 200
        events = parse_sse(resp.iter_lines())

    questions_seen = [e for e in events if e["event"] == "question"]
    assert len(questions_seen) == 1
    payload = json.loads(questions_seen[0]["data"])
    assert payload["tool_call_id"] == "tc-q1"
    assert len(payload["questions"]) == 1
    item = payload["questions"][0]
    assert item["header"] == "Pick"
    assert [o["label"] for o in item["options"]] == ["alpha", "beta"]
    # The "Other" choice is rendered client-side; the API surfaces only the
    # `allow_other` flag so the UI knows to add it.
    assert item["allow_other"] is True


def test_answer_endpoint_resumes_conversation(env: ApiEnv) -> None:
    """Full round-trip: agent stages, SSE delivers, client posts /answer,
    resumed turn streams a `done` event."""
    llm = FakeLlmClient(
        script=[
            tool_turn("tc-q1", "ask_user", _ASK_ARGS),
            text_turn("got it"),
        ]
    )
    client = build_client(env, llm=llm)

    with client.stream(
        "POST",
        "/items/S-1/conversation/messages",
        headers=AUTH_HEADERS,
        json={"text": "advise me"},
    ) as resp:
        events = parse_sse(resp.iter_lines())
    qid = json.loads(next(e for e in events if e["event"] == "question")["data"])["id"]

    with client.stream(
        "POST",
        "/items/S-1/conversation/answer",
        headers=AUTH_HEADERS,
        json={
            "question_id": qid,
            "answers": [{"selected": ["alpha"]}],
        },
    ) as resp:
        assert resp.status_code == 200
        answer_events = parse_sse(resp.iter_lines())

    # The resumed turn streams the model's reply, then `done`.
    text = "".join(json.loads(e["data"])["text"] for e in answer_events if e["event"] == "delta")
    assert text == "got it"
    assert any(e["event"] == "done" for e in answer_events)


def test_answer_endpoint_rejects_unknown_id(env: ApiEnv) -> None:
    llm = FakeLlmClient(script=[tool_turn("tc-q1", "ask_user", _ASK_ARGS)])
    client = build_client(env, llm=llm)

    with client.stream(
        "POST",
        "/items/S-1/conversation/messages",
        headers=AUTH_HEADERS,
        json={"text": "?"},
    ) as resp:
        list(resp.iter_lines())

    resp = client.post(
        "/items/S-1/conversation/answer",
        headers=AUTH_HEADERS,
        json={
            "question_id": "no-such-question",
            "answers": [{"selected": ["alpha"]}],
        },
    )
    assert resp.status_code == 409


def test_answer_endpoint_rejects_wrong_arity(env: ApiEnv) -> None:
    llm = FakeLlmClient(script=[tool_turn("tc-q1", "ask_user", _ASK_ARGS)])
    client = build_client(env, llm=llm)

    with client.stream(
        "POST",
        "/items/S-1/conversation/messages",
        headers=AUTH_HEADERS,
        json={"text": "?"},
    ) as resp:
        events = parse_sse(resp.iter_lines())
    qid = json.loads(next(e for e in events if e["event"] == "question")["data"])["id"]

    resp = client.post(
        "/items/S-1/conversation/answer",
        headers=AUTH_HEADERS,
        json={
            "question_id": qid,
            "answers": [],  # one question, zero answers
        },
    )
    assert resp.status_code == 400
