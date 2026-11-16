"""Dataclass <-> JSON, and a small JSON-Schema subset validator.

The dataclasses in limen.models / limen.contracts are the single source of
truth: JSON Schemas are generated from their type hints (exported to
``contracts/`` for the Node.js app), and every request and response is
validated against them with ``additionalProperties: false``. On the response
side that makes each schema an allow-list: a field that is not declared for an
audience cannot leave the service.

Supported schema keywords: type, enum, properties, required,
additionalProperties, items, anyOf, minimum, maximum, minLength, pattern, maxItems,
$ref (local, "#/$defs/Name").
"""
from __future__ import annotations

import dataclasses
import enum
import re
import types
import typing
from typing import Any

_NONE = type(None)


def F(default: Any = dataclasses.MISSING, *, default_factory: Any = dataclasses.MISSING, **constraints: Any):
    """Dataclass field carrying JSON-Schema constraints (minimum, maximum, ...)."""
    kwargs: dict[str, Any] = {"metadata": constraints}
    if default is not dataclasses.MISSING:
        kwargs["default"] = default
    if default_factory is not dataclasses.MISSING:
        kwargs["default_factory"] = default_factory
    return dataclasses.field(**kwargs)


def _hints(cls: type) -> dict[str, Any]:
    return typing.get_type_hints(cls)


def _is_union(tp: Any) -> bool:
    return typing.get_origin(tp) in (typing.Union, types.UnionType)


# --------------------------------------------------------------------------- schema generation
def _schema_for(tp: Any, defs: dict[str, Any]) -> dict[str, Any]:
    if tp is Any:
        return {}
    if tp is _NONE:
        return {"type": "null"}
    if tp is bool:
        return {"type": "boolean"}
    if tp is int:
        return {"type": "integer"}
    if tp is float:
        return {"type": "number"}
    if tp is str:
        return {"type": "string"}
    if _is_union(tp):
        return {"anyOf": [_schema_for(a, defs) for a in typing.get_args(tp)]}
    origin = typing.get_origin(tp)
    if origin is list:
        (item,) = typing.get_args(tp)
        return {"type": "array", "items": _schema_for(item, defs)}
    if origin is dict:
        _, val = typing.get_args(tp)
        return {"type": "object", "additionalProperties": _schema_for(val, defs)}
    if isinstance(tp, type) and issubclass(tp, enum.Enum):
        return {"type": "string", "enum": [m.value for m in tp]}
    if dataclasses.is_dataclass(tp):
        name = tp.__name__
        if name not in defs:
            defs[name] = {}  # placeholder guards against recursion
            props: dict[str, Any] = {}
            required: list[str] = []
            hints = _hints(tp)
            for fld in dataclasses.fields(tp):
                sub = dict(_schema_for(hints[fld.name], defs))
                sub.update(fld.metadata)
                props[fld.name] = sub
                if fld.default is dataclasses.MISSING and fld.default_factory is dataclasses.MISSING:
                    required.append(fld.name)
            defs[name] = {
                "type": "object",
                "properties": props,
                "required": required,
                "additionalProperties": False,
            }
        return {"$ref": f"#/$defs/{name}"}
    raise TypeError(f"unsupported type in schema: {tp!r}")


def json_schema(cls: type) -> dict[str, Any]:
    """Self-contained JSON Schema (draft 2020-12 subset) for a dataclass."""
    defs: dict[str, Any] = {}
    ref = _schema_for(cls, defs)
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": cls.__name__, **ref, "$defs": defs}


# --------------------------------------------------------------------------- validation
_TYPE_CHECKS = {
    "null": lambda v: v is None,
    "boolean": lambda v: isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "string": lambda v: isinstance(v, str),
    "array": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
}


def validate(instance: Any, schema: dict[str, Any], root: dict[str, Any] | None = None, path: str = "$") -> list[str]:
    """Return a list of human-readable violations (empty list = valid)."""
    root = root if root is not None else schema
    errors: list[str] = []
    if "$ref" in schema:
        name = schema["$ref"].rsplit("/", 1)[-1]
        return validate(instance, root["$defs"][name], root, path)
    if "anyOf" in schema:
        if not any(not validate(instance, s, root, path) for s in schema["anyOf"]):
            errors.append(f"{path}: does not match any allowed type")
        return errors
    t = schema.get("type")
    if t is not None and not _TYPE_CHECKS[t](instance):
        return [f"{path}: expected {t}, got {type(instance).__name__}"]
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: {instance!r} is not one of {schema['enum']}")
    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path}: {instance} is below the minimum {schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{path}: {instance} is above the maximum {schema['maximum']}")
    if isinstance(instance, str) and len(instance) < schema.get("minLength", 0):
        errors.append(f"{path}: string is shorter than {schema['minLength']}")
    if isinstance(instance, str) and "pattern" in schema and not re.fullmatch(schema["pattern"], instance):
        errors.append(f"{path}: {instance!r} does not match the pattern {schema['pattern']}")
    if isinstance(instance, list):
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{path}: more than {schema['maxItems']} items")
        if "items" in schema:
            for i, item in enumerate(instance):
                errors.extend(validate(item, schema["items"], root, f"{path}[{i}]"))
    if isinstance(instance, dict):
        props = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in instance:
                errors.append(f"{path}: missing required field '{name}'")
        extra = schema.get("additionalProperties", True)
        for key, value in instance.items():
            if key in props:
                errors.extend(validate(value, props[key], root, f"{path}.{key}"))
            elif extra is False:
                errors.append(f"{path}: unexpected field '{key}'")
            elif isinstance(extra, dict):
                errors.extend(validate(value, extra, root, f"{path}.{key}"))
    return errors


# --------------------------------------------------------------------------- (de)serialisation
def to_dict(obj: Any) -> Any:
    """Dataclasses / enums / containers -> plain JSON-compatible data."""
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: to_dict(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
    if isinstance(obj, enum.Enum):
        return obj.value
    if isinstance(obj, (list, tuple)):
        return [to_dict(v) for v in obj]
    if isinstance(obj, dict):
        return {k: to_dict(v) for k, v in obj.items()}
    return obj


def _convert(tp: Any, value: Any) -> Any:
    if tp is Any or value is None:
        return value
    if _is_union(tp):
        last_error: Exception | None = None
        for arg in typing.get_args(tp):
            if arg is _NONE:
                continue
            try:
                return _convert(arg, value)
            except (TypeError, ValueError, KeyError) as exc:
                last_error = exc
        raise TypeError(f"cannot convert {value!r} to {tp}") from last_error
    origin = typing.get_origin(tp)
    if origin is list:
        (item,) = typing.get_args(tp)
        return [_convert(item, v) for v in value]
    if origin is dict:
        _, val = typing.get_args(tp)
        return {k: _convert(val, v) for k, v in value.items()}
    if isinstance(tp, type) and issubclass(tp, enum.Enum):
        return tp(value)
    if dataclasses.is_dataclass(tp):
        return from_dict(tp, value)
    if tp is float and isinstance(value, int) and not isinstance(value, bool):
        return float(value)
    return value


def from_dict(cls: type, data: dict[str, Any]) -> Any:
    """Build a dataclass from validated JSON data (call ``validate`` first)."""
    hints = _hints(cls)
    kwargs = {f.name: _convert(hints[f.name], data[f.name]) for f in dataclasses.fields(cls) if f.name in data}
    return cls(**kwargs)


def parse(cls: type, data: Any) -> Any:
    """Validate ``data`` against the schema of ``cls`` and build the object."""
    errors = validate(data, json_schema(cls))
    if errors:
        raise SchemaError(errors)
    return from_dict(cls, data)


class SchemaError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors[:5]))
        self.errors = errors
