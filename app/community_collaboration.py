"""Compatibility import for the independently packaged people feature."""
from app._plugin_compat import alias
alias(__name__, "buddy_people.community_collaboration", "people")
