import re
from datetime import date
from typing import Optional

_SLOT_RE = re.compile(
    r"Earliest available slot for [\d,]+ Applicants is\s*:\s*(\d{2})-(\d{2})-(\d{4})"
)


def parse_earliest_slot(page_text: str) -> Optional[date]:
    match = _SLOT_RE.search(page_text)
    if not match:
        return None
    day, month, year = match.groups()
    return date(int(year), int(month), int(day))
