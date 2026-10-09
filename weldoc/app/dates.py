"""Date formatting shared by the document generators.

Dates are stored as free-form NVARCHAR strings (entered by different screens over
time), so anything printed on a document goes through fmt_date first.

Documents print dates as "08. Okt. 2026": day, German month abbreviation, year
(2026-10-09). The database keeps storing them as numbers (YYYY-MM-DD).
"""

from datetime import date, datetime

MONTHS_DE = ("Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez")

_DATE_PATTERNS = (
    "%Y-%m-%d",
    "%d-%m-%Y",
    "%d.%m.%Y",
    "%d/%m/%Y",
    "%Y/%m/%d",
    "%Y.%m.%d",
)


def fmt_day(d):
    """A date / datetime as "08. Okt. 2026"."""
    return f"{d.day:02d}. {MONTHS_DE[d.month - 1]}. {d.year}"


def fmt_date(value):
    """Format a stored date string as "08. Okt. 2026".

    Returns "" for empty input and the original string if it cannot be parsed,
    so an unexpected value is still shown rather than silently dropped (an
    already formatted date therefore passes through unchanged).
    """
    if not value:
        return ""
    if isinstance(value, (date, datetime)):
        return fmt_day(value)
    s = str(value).strip()
    if not s:
        return ""
    base = s.split("T")[0].split(" ")[0]
    for pattern in _DATE_PATTERNS:
        try:
            return fmt_day(datetime.strptime(base, pattern))
        except ValueError:
            continue
    return s


def fmt_datetime(value):
    """A stored timestamp ("2026-10-08T13:38:05" or a datetime) as "08. Okt. 2026 13:38:05"."""
    if not value:
        return ""
    if isinstance(value, datetime):
        return f"{fmt_day(value)} {value:%H:%M:%S}"
    s = str(value).replace("T", " ")[:19]
    try:
        return fmt_datetime(datetime.strptime(s, "%Y-%m-%d %H:%M:%S"))
    except ValueError:
        return fmt_date(s)


def today_str():
    """Today's date in the document display format."""
    return fmt_day(datetime.now())
