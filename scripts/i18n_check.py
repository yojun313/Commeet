"""영문 사전(app/static/js/i18n-en.js)에 빠진 화면 문장을 찾습니다.

템플릿·JS·서버 메시지에서 한국어가 들어간 문장을 뽑아 사전과 비교합니다.
화면 문구를 새로 넣거나 고친 뒤 돌려서, 나온 문장을 i18n-en.js에 추가하면
됩니다. 끼어드는 값(이름·숫자 등)은 {0}, {1}로 나옵니다 - 사전 키도 같은
모양으로 적습니다.

    .venv/bin/python scripts/i18n_check.py

주석·독스트링·메일 본문(email_service.py)·학생지도비 신청서(record_print.html,
학교에 내는 서류라 한국어 그대로 둡니다)는 대상이 아닙니다.
"""

import ast
import html
import json
import os
import re
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HANGUL = re.compile(r"[가-힣]")
TAG = re.compile(r"<[^>]*>")
ATTR = re.compile(r'(?:placeholder|title|aria-label|alt|content)="([^"]*)"')
HOLE = "\x00"  # JS 템플릿 리터럴의 ${...} 자리

SKIP_TEMPLATES = {"record_print.html"}
SKIP_PY = {"email_service.py"}


def unescape_js(s: str) -> str:
    return re.sub(
        r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), s
    )


class Collector:
    def __init__(self) -> None:
        self.found: dict[str, set[str]] = defaultdict(set)

    def add(self, text: str, source: str) -> None:
        # 화면에 그려진 글자와 같은 모양으로 맞춥니다 (i18n.js의 norm()).
        text = re.sub(r"\s+", " ", html.unescape(text)).strip()
        if HANGUL.search(text):
            self.found[text].add(source)

    def add_markup(self, text: str, source: str) -> None:
        """태그로 나뉜 조각마다 하나씩. 자리는 조각 안에서 {0}부터 셉니다."""
        for piece in TAG.split(text):
            holes = iter(range(100))
            self.add(re.sub(HOLE, lambda _: "{%d}" % next(holes), piece), source)
        for m in ATTR.finditer(text):
            self.add(m.group(1).replace(HOLE, "{0}"), source)


def js_strings(code: str) -> list[str]:
    """JS 소스의 문자열·템플릿 리터럴 내용 (주석은 건너뜀)."""
    found: list[str] = []
    i, n = 0, len(code)
    while i < n:
        if code.startswith("//", i):
            j = code.find("\n", i)
            i = n if j < 0 else j
        elif code.startswith("/*", i):
            j = code.find("*/", i + 2)
            i = n if j < 0 else j + 2
        elif code[i] in "\"'":
            quote, j, buf = code[i], i + 1, []
            while j < n and code[j] != quote:
                step = 2 if code[j] == "\\" else 1
                buf.append(code[j : j + step])
                j += step
            found.append(unescape_js("".join(buf)))
            i = j + 1
        elif code[i] == "`":
            j, buf = i + 1, []
            while j < n and code[j] != "`":
                if code[j] == "\\":
                    buf.append(unescape_js(code[j : j + 2]))
                    j += 2
                elif code.startswith("${", j):
                    # ${...} 안의 식은 따로 훑습니다 (안에 든 문자열·템플릿도 대상).
                    depth, start = 1, j + 2
                    j = start
                    while j < n and depth:
                        if code[j] in "\"'`":
                            quote = code[j]
                            j += 1
                            while j < n and code[j] != quote:
                                j += 2 if code[j] == "\\" else 1
                        elif code[j] == "{":
                            depth += 1
                        elif code[j] == "}":
                            depth -= 1
                        j += 1
                    found.extend(js_strings(code[start : j - 1]))
                    buf.append(HOLE)
                else:
                    buf.append(code[j])
                    j += 1
            found.append("".join(buf))
            i = j + 1
        else:
            i += 1
    return found


def scan_js(c: Collector) -> None:
    for dirpath, _, files in os.walk(os.path.join(ROOT, "app/static/js")):
        for name in files:
            if not name.endswith(".js") or name == "i18n-en.js":
                continue
            path = os.path.join(dirpath, name)
            source = os.path.relpath(path, ROOT)
            for s in js_strings(open(path, encoding="utf-8").read()):
                c.add_markup(s, source)


def scan_templates(c: Collector) -> None:
    for dirpath, _, files in os.walk(os.path.join(ROOT, "app/templates")):
        for name in files:
            if not name.endswith(".html") or name in SKIP_TEMPLATES:
                continue
            path = os.path.join(dirpath, name)
            source = os.path.relpath(path, ROOT)
            t = open(path, encoding="utf-8").read()
            t = re.sub(r"\{#.*?#\}|<!--.*?-->", "", t, flags=re.S)
            for m in re.finditer(r"<script[^>]*>(.*?)</script>", t, flags=re.S):
                for s in js_strings(m.group(1)):
                    c.add_markup(s, source)
            t = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", t, flags=re.S)
            # Jinja 식 안의 문자열 ({{ '삭제' if ... }})
            for m in re.finditer(r"\{[{%].*?[}%]\}", t, flags=re.S):
                for a, b in re.findall(r"'([^']*)'|\"([^\"]*)\"", m.group(0)):
                    c.add(a or b, source)
            t = re.sub(r"\{%.*?%\}", "<>", t, flags=re.S)
            c.add_markup(re.sub(r"\{\{.*?\}\}", HOLE, t, flags=re.S), source)


def scan_python(c: Collector) -> None:
    for sub in ("app", "app/core", "app/routes", "app/services"):
        folder = os.path.join(ROOT, sub)
        for name in os.listdir(folder):
            if not name.endswith(".py") or name in SKIP_PY:
                continue
            path = os.path.join(folder, name)
            source = os.path.relpath(path, ROOT)
            tree = ast.parse(open(path, encoding="utf-8").read())
            # 독스트링과 혼자 서 있는 문자열은 화면에 나가지 않습니다.
            skip = {
                id(node.value)
                for node in ast.walk(tree)
                if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
            }
            for node in ast.walk(tree):
                if isinstance(node, ast.JoinedStr):
                    holes = iter(range(100))
                    text = ""
                    for v in node.values:
                        if isinstance(v, ast.Constant):
                            text += str(v.value)
                            skip.add(id(v))
                        else:
                            text += "{%d}" % next(holes)
                    c.add(text, source)
            for node in ast.walk(tree):
                if (
                    isinstance(node, ast.Constant)
                    and isinstance(node.value, str)
                    and id(node) not in skip
                ):
                    c.add(node.value, source)


def load_dictionary() -> dict:
    text = open(os.path.join(ROOT, "app/static/js/i18n-en.js"), encoding="utf-8").read()
    body = text[text.index("window.I18N_EN = ") + len("window.I18N_EN = ") :]
    body = body[: body.rindex("}") + 1]
    return json.loads(re.sub(r",\s*}$", "}", body))


def main() -> int:
    c = Collector()
    scan_js(c)
    scan_templates(c)
    scan_python(c)
    known = load_dictionary()
    missing = sorted(
        (min(src), text) for text, src in c.found.items() if text not in known
    )
    for source, text in missing:
        print(f"{source}\t{text}")
    print(f"{len(missing)} missing of {len(c.found)}", file=sys.stderr)
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
