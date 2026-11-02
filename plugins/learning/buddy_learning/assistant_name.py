"""The assistant name a user chose in Appearance, for Learning prompts."""
from app.branding import brand_name

# Same character rules as the main chat request, so a name cannot carry instructions.
ASSISTANT_NAME_PATTERN = r"^[\p{L}\p{N}][\p{L}\p{N} '\-]{0,48}$"


def assistant_label(name=None):
    return name or brand_name()
