"""Preserve the explicit topic structure in a learner's Markdown outline."""

import re

from markdown_it import MarkdownIt


def outline_paths(text: str, *, headings_only: bool = False) -> list[tuple[str, ...]]:
    headings: list[tuple[int, str]] = []
    list_items: list[str | None] = []
    paths = []
    tokens = MarkdownIt().parse(text)

    for index, token in enumerate(tokens):
        if token.type == "list_item_open" and not headings_only:
            list_items.append(None)
        elif token.type == "list_item_close" and not headings_only:
            list_items.pop()
        elif token.type == "inline":
            previous = tokens[index - 1]
            is_heading = previous.type == "heading_open" and previous.level == 0
            is_list_title = (
                not headings_only and bool(list_items) and list_items[-1] is None
                and previous.type == "paragraph_open"
            )
            if not is_heading and not is_list_title:
                if headings_only or previous.type != "paragraph_open" or list_items:
                    continue

                # Some pasted curricula use "Step 1:" and arrows instead of Markdown syntax.
                lines = []
                line_parts = []
                for child in token.children or []:
                    if child.type in {"softbreak", "hardbreak"}:
                        lines.append("".join(line_parts).strip())
                        line_parts = []
                    elif child.type in {"text", "code_inline"}:
                        line_parts.append(child.content)
                lines.append("".join(line_parts).strip())

                for line in lines:
                    step = re.fullmatch(r"Step\s+\d+\s*:\s+.+", line, re.IGNORECASE)
                    if step:
                        while headings and headings[-1][0] >= 2:
                            headings.pop()
                        headings.append((2, line if len(line) <= 200 else ""))
                        path = tuple(title for _, title in headings)
                    elif line.startswith("→ "):
                        title = line[2:].strip()
                        path = tuple(title for _, title in headings) + (
                            title if len(title) <= 200 else "",
                        )
                    else:
                        continue
                    if all(path):
                        paths.append(path)
                continue

            title_parts = []
            for child in token.children or []:
                if child.type in {"text", "code_inline"}:
                    title_parts.append(child.content)
                elif child.type in {"softbreak", "hardbreak"}:
                    title_parts.append(" ")
            title = " ".join("".join(title_parts).split())
            if is_heading:
                level = int(previous.tag[1:])
                while headings and headings[-1][0] >= level:
                    headings.pop()
                headings.append((level, title if 0 < len(title) <= 200 else ""))
                path = tuple(title for _, title in headings)
            else:
                title = title.split(":", 1)[0].strip()
                list_items[-1] = title if 0 < len(title) <= 200 else ""
                path = tuple(title for _, title in headings) + tuple(
                    title or "" for title in list_items
                )

            # An unrecognized parent cannot give its children a reliable outline path.
            if all(path):
                paths.append(path)

    return paths


def source_roadmap_paths(text: str) -> list[tuple[str, ...]]:
    """Read article section headings, including numbered headings from older plain-text imports."""
    headings = outline_paths(text, headings_only=True)
    if len(headings) >= 2:
        return headings

    numbered: list[tuple[str, ...]] = []
    for line in text.splitlines():
        match = re.fullmatch(r"\s*(\d{1,2})[.)]\s+(.{1,180}?)\s*", line)
        if not match:
            continue
        number, title = int(match[1]), match[2].strip()
        if number == 1:
            numbered = [(title,)]
        elif number == len(numbered) + 1:
            numbered.append((title,))
    return numbered if len(numbered) >= 2 else []


def preserves_outline(nodes: list[dict], required: list[tuple[str, ...]]) -> bool:
    required_paths = set(required)
    if len(required_paths) != len(required):
        return False

    matched = []

    def visit(branches: list[dict], ancestors: tuple[str, ...] = ()):
        for node in branches:
            path = ancestors + (node["title"],)
            if path in required_paths:
                matched.append(path)
            visit(node.get("children", []), path)

    visit(nodes)
    return matched == required
