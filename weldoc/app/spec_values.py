"""Material specification numbers: what is stored, and how it is shown.

The database keeps only the number for these fields. Everything the app reads comes back
in one fixed display form, and everything it writes may be typed with or without the unit:

    field            stored        shown (read)      accepted when saving
    DN 1-6           25            "DN 25"           25 | "25" | "DN 25" | "dn25"
    diameter 1-3     33.7          "33.7"            "33.7" | "33,7" | "Ø 33.7 mm"   (screens add "Ø ... mm")
    thickness 1-3    2.0           "2.0 mm"          "2" | "2.0" | "2,0 mm"
    surface          0.6           "Ra 0.6 µm"       "0.6" | "Ra 0,6 µm"
    material code    1.4404        "1.4404"          "1.4404" | "1,4404"

Decimals: diameter, thickness and surface show at least one decimal and any further ones
that are stored (2 -> "2.0", 33.25 -> "33.25"). The material code always shows exactly four
(1.455 -> "1.4550"), because real material numbers are 1.xxxx and 1.4550 must not appear as
1.455. At most four decimals are accepted; anything that is not a number is refused.

The column types below (TypeDecorator) apply this on every ORM read and write, so the rest
of the code keeps working with the display strings it always had. Raw SQL results go
through spec_rows(). Values that are not numbers - old rows from before this existed - are
shown as they are instead of breaking the page, and refused only when saved again.
"""

import re
from decimal import Decimal, InvalidOperation

from sqlalchemy.types import String, TypeDecorator

MAX_DECIMALS = 4


class SpecValueError(ValueError):
    """A specification value that is not a valid number. Turned into a 400 response."""


# Unit words and signs people type around the number: "DN" / "Ra" in front, "Ø" in front,
# "mm" / "µm" behind. The field holds nothing else, so they can simply be removed.
_PREFIX = re.compile(r"(?i)^\s*(dn|ra)")
_UNIT_TOKENS = re.compile(r"(?i)(µm|μm|um|mm|ø|⌀)")


def _clean(value):
    if value is None:
        return ""
    if isinstance(value, (int, Decimal)) and not isinstance(value, bool):
        return format(value, "f")
    s = _PREFIX.sub("", str(value).strip())
    s = _UNIT_TOKENS.sub("", s)
    return s.replace(" ", "").replace(",", ".")


def _parse_decimal(value, label):
    s = _clean(value)
    if s == "":
        return None
    if not re.fullmatch(r"\d+(\.\d+)?", s):
        raise SpecValueError(f"{label}: '{value}' is not a number. Enter only the number, e.g. 2.0.")
    d = Decimal(s)
    if -d.as_tuple().exponent > MAX_DECIMALS:
        raise SpecValueError(f"{label}: '{value}' has more than {MAX_DECIMALS} decimals.")
    return d


def _parse_int(value, label):
    s = _clean(value)
    if s == "":
        return None
    if re.fullmatch(r"\d+\.0+", s):          # 25.0 from a decimal column is still 25
        s = s.split(".")[0]
    if not re.fullmatch(r"\d+", s) or int(s) == 0:
        raise SpecValueError(f"{label}: '{value}' is not a whole number. Enter only the number, e.g. 25.")
    return int(s)


def _min1(d):
    """At least one decimal, and every further one that is really there: 2 -> 2.0, 2.50 -> 2.5."""
    s = format(d.normalize(), "f")
    if "." not in s:
        s += ".0"
    return s


# --- display form (what reads return) ---------------------------------------------------

def _shown(parse, fmt, value, label):
    if value is None or (isinstance(value, str) and value.strip() == ""):
        return value if value is None else ""
    try:
        n = parse(value, label)
    except SpecValueError:
        return str(value).strip()           # an old non-numeric value: show it, do not break
    return "" if n is None else fmt(n)


def show_dn(value):
    return _shown(_parse_int, lambda n: f"DN {n}", value, "DN")


def show_diameter(value):
    return _shown(_parse_decimal, _min1, value, "Diameter")


def show_thickness(value):
    return _shown(_parse_decimal, lambda d: f"{_min1(d)} mm", value, "Thickness")


def show_surface(value):
    return _shown(_parse_decimal, lambda d: f"Ra {_min1(d)} µm", value, "Surface")


def show_material_code(value):
    return _shown(_parse_decimal, lambda d: f"{d:.4f}", value, "Material code")


# --- stored form (what writes send) ------------------------------------------------------
# A plain number as text. It fits the old text columns and converts implicitly into the
# INT / DECIMAL columns the migration introduces, so the same code runs before and after it.

def store_dn(value):
    n = _parse_int(value, "DN")
    return None if n is None else str(n)


def store_diameter(value):
    d = _parse_decimal(value, "Diameter")
    return None if d is None else _min1(d)


def store_thickness(value):
    d = _parse_decimal(value, "Thickness")
    return None if d is None else _min1(d)


def store_surface(value):
    d = _parse_decimal(value, "Surface")
    return None if d is None else _min1(d)


def store_material_code(value):
    d = _parse_decimal(value, "Material code")
    return None if d is None else f"{d:.4f}"


# --- validated display form, for comparing and for the request payloads -------------------

def canon_dn(value):
    s = store_dn(value)
    return "" if s is None else show_dn(s)


def canon_diameter(value):
    s = store_diameter(value)
    return "" if s is None else show_diameter(s)


def canon_thickness(value):
    s = store_thickness(value)
    return "" if s is None else show_thickness(s)


def canon_surface(value):
    s = store_surface(value)
    return "" if s is None else show_surface(s)


def canon_material_code(value):
    s = store_material_code(value)
    return "" if s is None else show_material_code(s)


# --- column types -------------------------------------------------------------------------

class _SpecColumn(TypeDecorator):
    impl = String
    cache_ok = True
    _store = staticmethod(lambda v: v)
    _show = staticmethod(lambda v: v)

    def process_bind_param(self, value, dialect):
        return self._store(value)

    def process_result_value(self, value, dialect):
        return None if value is None else self._show(value)


class DnColumn(_SpecColumn):
    cache_ok = True
    _store = staticmethod(store_dn)
    _show = staticmethod(show_dn)


class DiameterColumn(_SpecColumn):
    cache_ok = True
    _store = staticmethod(store_diameter)
    _show = staticmethod(show_diameter)


class ThicknessColumn(_SpecColumn):
    cache_ok = True
    _store = staticmethod(store_thickness)
    _show = staticmethod(show_thickness)


class SurfaceColumn(_SpecColumn):
    cache_ok = True
    _store = staticmethod(store_surface)
    _show = staticmethod(show_surface)


class MaterialCodeColumn(_SpecColumn):
    cache_ok = True
    _store = staticmethod(store_material_code)
    _show = staticmethod(show_material_code)


# --- whole numbers and dates (welds, pipelines, certificates, projects) ---------------------
# Same idea as above: the database keeps a real number / date, the app reads a plain string
# ("14", "2026-07-10") exactly as it did when these columns were text, and a save accepts
# the value in the forms people type it. Dates are always read and written as YYYY-MM-DD;
# the screens and documents show them as DD.MM.YYYY (app/dates.py, formatDate in app.js).

import datetime as _dt

_DATE_FORMATS = ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d", "%Y.%m.%d")


def _parse_whole(value, label):
    if value is None:
        return None
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, Decimal):
        if value == value.to_integral_value():
            return int(value)
        raise SpecValueError(f"{label}: '{value}' is not a whole number.")
    s = str(value).strip()
    if s == "":
        return None
    if not re.fullmatch(r"\d+", s):
        raise SpecValueError(f"{label}: '{value}' is not a whole number.")
    return int(s)


def _parse_date(value, label):
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        return value.date()
    if isinstance(value, _dt.date):
        return value
    s = str(value).strip()
    if s == "":
        return None
    base = s.split("T")[0].split(" ")[0]
    for fmt in _DATE_FORMATS:
        try:
            return _dt.datetime.strptime(base, fmt).date()
        except ValueError:
            continue
    raise SpecValueError(f"{label}: '{value}' is not a valid date.")


def show_whole(value):
    """A whole number as a plain string ("14"); an old non-number value is shown as it is."""
    if value is None:
        return None
    try:
        n = _parse_whole(value, "")
    except SpecValueError:
        return str(value).strip()
    return "" if n is None else str(n)


def show_date(value):
    """A date as YYYY-MM-DD; an old value that is not a date is shown as it is."""
    if value is None:
        return None
    try:
        d = _parse_date(value, "")
    except SpecValueError:
        return str(value).strip()
    return "" if d is None else d.isoformat()


def store_whole(value, label, required=False):
    n = _parse_whole(value, label)
    if n is None:
        if required:
            raise SpecValueError(f"{label} must be filled in.")
        return None
    return str(n)


def store_date(value, label):
    d = _parse_date(value, label)
    return None if d is None else d.isoformat()


class _LabelledColumn(TypeDecorator):
    """Column type with a field label for the error message ("Weld date: ... is not a valid date")."""
    impl = String
    cache_ok = True

    def __init__(self, length=None, label="Value", required=False):
        super().__init__(length)
        self.label = label
        self.required = required


class WholeNumberColumn(_LabelledColumn):
    cache_ok = True
    def process_bind_param(self, value, dialect):
        return store_whole(value, self.label, self.required)

    def process_result_value(self, value, dialect):
        return show_whole(value)


class DateColumn(_LabelledColumn):
    cache_ok = True
    def process_bind_param(self, value, dialect):
        return store_date(value, self.label)

    def process_result_value(self, value, dialect):
        return show_date(value)


# --- raw SQL results ------------------------------------------------------------------------

SHOW_BY_COLUMN = {
    **{f"dn{i}": show_dn for i in range(1, 7)},
    "diameter": show_diameter, "diameter2": show_diameter, "diameter3": show_diameter,
    "thickness": show_thickness, "thickness2": show_thickness, "thickness3": show_thickness,
    "surface": show_surface,
    "material_code": show_material_code,
    # whole numbers and dates
    "weld_no": show_whole, "procedure": show_whole, "ist_project_no": show_whole,
    "date": show_date, "welding_start": show_date, "welding_end": show_date,
    "valid_until": show_date, "renewal_due": show_date,
}


class _SpecRow:
    """A result row whose specification columns read in display form; the rest unchanged."""

    __slots__ = ("_row",)

    def __init__(self, row):
        self._row = row

    def __getattr__(self, name):
        value = getattr(self._row, name)
        show = SHOW_BY_COLUMN.get(name)
        return show(value) if show and value is not None else value


def spec_rows(rows):
    """Wrap raw SQL rows (from .fetchall()) so dn1, diameter, dates ... come out in display form."""
    return [_SpecRow(r) for r in rows]


def spec_row(row):
    """The same for one row from .fetchone(); None stays None."""
    return None if row is None else _SpecRow(row)
