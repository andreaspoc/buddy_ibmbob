"""
GoRules Zen-Engine Compatible Python Binding for DecisionsBuddy.
Provides in-process execution of JSON Decision Models (JDM) matching
the official zen-engine PyPI package interface.
"""

import time
import json
from typing import Any, Callable, Dict, Optional, Union
from app.decisions_buddy.decision_engine import DecisionEngine, evaluate_unary, evaluate_expression
from app.decisions_buddy.safe_expression import validate_graph


class ZenDecisionContent:
    """Wrapper around decision graph content (dict, bytes, or json string)."""
    def __init__(self, content: Union[str, bytes, Dict[str, Any]]):
        if isinstance(content, bytes):
            content = content.decode("utf-8")
        if isinstance(content, str):
            self.data = json.loads(content)
        elif isinstance(content, dict):
            self.data = dict(content)
        else:
            raise TypeError(f"Invalid decision content type: {type(content)}")
        
        # Extract graph if wrapped
        if "graph" in self.data and isinstance(self.data["graph"], dict):
            self.graph = self.data["graph"]
        else:
            self.graph = self.data


class ZenDecision:
    """Executable decision instance matching GoRules ZenDecision."""
    def __init__(self, content: Union[ZenDecisionContent, str, bytes, Dict[str, Any]], engine: Optional["ZenEngine"] = None):
        if isinstance(content, ZenDecisionContent):
            self._content = content
        else:
            self._content = ZenDecisionContent(content)
        self._engine = engine or DecisionEngine()
        self._validated_graph = validate_graph(self._content.graph)

    @property
    def graph(self) -> Dict[str, Any]:
        return self._validated_graph

    def evaluate(self, context: Dict[str, Any], options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Evaluates the decision against the provided context.
        Returns a dict matching GoRules Zen response:
        {
            "result": {...},
            "performance": "12.3µs" or dict,
            "trace": [...]
        }
        """
        start_ns = time.perf_counter_ns()
        res = self._engine.evaluate(self._validated_graph, context)
        elapsed_ns = time.perf_counter_ns() - start_ns

        perf_str = f"{elapsed_ns / 1000.0:.1f}µs"
        output = {
            "result": res.get("result", {}),
            "performance": perf_str,
            "performanceDetails": {
                "durationNs": elapsed_ns,
                "nodesExecuted": res.get("performance", {}).get("nodesExecuted", 0)
            }
        }
        if options and options.get("trace"):
            output["trace"] = res.get("trace", [])
        return output

    async def async_evaluate(self, context: Dict[str, Any], options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Async evaluation alias."""
        return self.evaluate(context, options)

    def dispose(self):
        """No-op resource cleanup for API compatibility."""
        pass


class ZenEngine:
    """
    GoRules ZenEngine compatible class for evaluating JSON Decision Models.
    Matches PyPI zen-engine / @gorules/zen-engine API.
    """
    def __init__(self, options: Optional[Dict[str, Any]] = None):
        options = options or {}
        self.loader: Optional[Callable[[str], Any]] = options.get("loader")
        self._decisions: Dict[str, ZenDecision] = {}
        self._raw_engine = DecisionEngine()

    def create_decision(self, content: Union[ZenDecisionContent, str, bytes, Dict[str, Any]]) -> ZenDecision:
        """Creates a compiled ZenDecision from content."""
        return ZenDecision(content, engine=self._raw_engine)

    def get_decision(self, key: str) -> Optional[ZenDecision]:
        """Retrieves or loads a decision by key."""
        if key in self._decisions:
            return self._decisions[key]
        if self.loader:
            loaded_content = self.loader(key)
            if loaded_content is not None:
                dec = self.create_decision(loaded_content)
                self._decisions[key] = dec
                return dec
        return None

    def evaluate(
        self,
        key_or_content: Union[str, bytes, Dict[str, Any]],
        content_or_context: Union[str, bytes, Dict[str, Any]],
        context_or_options: Optional[Dict[str, Any]] = None,
        options: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Evaluates a decision. Supports GoRules Zen signatures:
        1. evaluate(key, context, options=None) [when key loaded via loader or cache]
        2. evaluate(content, context, options=None)
        3. evaluate(key, content, context, options=None)
        """
        if context_or_options is None and options is None:
            # Could be evaluate(key, context) OR evaluate(content, context)
            if isinstance(key_or_content, str) and (key_or_content in self._decisions or self.loader):
                dec = self.get_decision(key_or_content)
                if dec is not None:
                    return dec.evaluate(content_or_context, {})
            # Otherwise evaluate(content, context)
            content = key_or_content
            context = content_or_context
            opts = {}
        elif options is None and isinstance(key_or_content, str) and not isinstance(content_or_context, (str, bytes)):
            # evaluate(key, context, options)
            key = key_or_content
            context = content_or_context
            opts = context_or_options or {}
            dec = self.get_decision(key)
            if dec is None:
                raise KeyError(f"Decision '{key}' not found and no loader resolved it")
            return dec.evaluate(context, opts)
        else:
            # evaluate(key, content, context, options)
            content = content_or_context
            context = context_or_options or {}
            opts = options or {}

        dec = self.create_decision(content)
        return dec.evaluate(context, opts)

    def dispose(self):
        self._decisions.clear()


# Default exports matching zen_engine
__all__ = ["ZenEngine", "ZenDecision", "ZenDecisionContent"]
