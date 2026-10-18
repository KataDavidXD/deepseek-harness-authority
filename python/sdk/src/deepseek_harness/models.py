from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Annotated, Literal, TypeAlias

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
)

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | dict[str, "JsonValue"] | list["JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]


@dataclass(slots=True)
class Notification:
    method: str
    payload: JsonObject


@dataclass(slots=True)
class IncomingRequest:
    id: str | int
    method: str
    payload: JsonObject


class ServerInfo(BaseModel):
    name: str | None = None
    version: str | None = None


class RuntimeBindingEnvelope(BaseModel):
    """Path-free proof of one compatible persistence store instance."""

    model_config = ConfigDict(populate_by_name=True, frozen=True, extra="forbid")

    protocol_version: Literal[1] = Field(alias="protocolVersion")
    schema_version: Literal[2] = Field(alias="schemaVersion")
    persistence_instance_id: StrictStr = Field(alias="persistenceInstanceId")
    root_config_sha256: StrictStr = Field(alias="rootConfigSha256")

    @field_validator("persistence_instance_id")
    @classmethod
    def _validate_instance_id(cls, value: str) -> str:
        if re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            value,
        ) is None:
            raise ValueError("persistence_instance_id must be a canonical UUIDv4")
        return value

    @field_validator("root_config_sha256")
    @classmethod
    def _validate_root_config_sha256(cls, value: str) -> str:
        if re.fullmatch(r"[0-9a-f]{64}", value) is None:
            raise ValueError("root_config_sha256 must be a lowercase SHA-256 digest")
        return value


@dataclass(frozen=True, slots=True)
class RuntimeProcessBinding:
    """One initialized runtime binding pinned to one live subprocess generation."""

    runtime_binding: RuntimeBindingEnvelope
    process_generation: str


class InitializeResponse(BaseModel):
    serverInfo: ServerInfo | None = None
    runtime_binding: RuntimeBindingEnvelope | None = Field(default=None, alias="runtimeBinding")


class AttemptIdentity(BaseModel):
    """Runtime-owned identity echoed by every durable attempt receipt."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    session_id: StrictStr = Field(alias="sessionId", min_length=1)
    attempt_id: StrictStr = Field(alias="attemptId", min_length=1)
    input_sha256: StrictStr = Field(alias="inputSha256")
    message_id: StrictStr = Field(alias="messageId", min_length=1)
    runtime_binding: RuntimeBindingEnvelope = Field(alias="runtimeBinding")

    @field_validator("input_sha256")
    @classmethod
    def _validate_input_sha256(cls, value: str) -> str:
        if re.fullmatch(r"[0-9a-f]{64}", value) is None:
            raise ValueError("input_sha256 must be a lowercase SHA-256 digest")
        return value


class PendingAttemptReceipt(AttemptIdentity):
    """A durable attempt accepted but not yet terminal."""

    status: Literal["queued", "running"]
    turn: Annotated[StrictInt, Field(ge=0)] | None = None


class TerminalAttemptReceipt(AttemptIdentity):
    """Runtime-owned terminal proof for one exact durable attempt."""

    status: Literal["terminal"]
    turn: Annotated[StrictInt, Field(ge=0)] | None = None
    terminal_event_seq: Annotated[StrictInt, Field(ge=0)] = Field(alias="terminalEventSeq")
    finish_reason: dict[str, object] = Field(alias="finishReason")
    final_response: StrictStr = Field(alias="finalResponse")

    @field_validator("finish_reason")
    @classmethod
    def _validate_finish_reason(cls, value: dict[str, object]) -> dict[str, object]:
        kind = value.get("kind")
        if not isinstance(kind, str) or not kind:
            raise ValueError("finish_reason.kind must be a non-empty string")
        return value


AttemptReceipt: TypeAlias = Annotated[
    PendingAttemptReceipt | TerminalAttemptReceipt,
    Field(discriminator="status"),
]


class AttemptStartResult(BaseModel):
    """Result of idempotently admitting one durable attempt."""

    attempt: AttemptReceipt
    deduplicated: StrictBool


class AttemptGetResult(BaseModel):
    """Wire wrapper for a durable lookup."""

    attempt: AttemptReceipt | None


class AttemptCancelResult(BaseModel):
    """Wire wrapper for a durable cancellation result."""

    attempt: TerminalAttemptReceipt
