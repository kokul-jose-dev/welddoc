"""Date formatting shared by the document generators.

Dates are stored as free-form NVARCHAR strings (entered by different screens over
time), so anything printed on a document goes through fmt_date first.
"""

from datetime import datetime

DISPLAY_FORMAT = "%d.%m.%Y"

_DATE_PATTERNS = (
    "%Y-%m-%d",
    "%d-%m-%Y",
    "%d.%m.%Y",
    "%d/%m/%Y",
    "%Y/%m/%d",
    "%Y.%m.%d",
)


def fmt_date(value):
    """Format a stored date string as DD/MM/YYYY.

    Returns "" for empty input and the original string if it cannot be parsed,
    so an unexpected value is still shown rather than silently dropped.
    """
    if not value:
        return ""
    s = str(value).strip()
    if not s:
        return ""
    base = s.split("T")[0].split(" ")[0]
    for pattern in _DATE_PATTERNS:
        try:
            return datetime.strptime(base, pattern).strftime(DISPLAY_FORMAT)
        except ValueError:
            continue
    return s


def today_str():
    """Today's date in the document display format."""
    return datetime.now().strftime(DISPLAY_FORMAT)
