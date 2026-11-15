"""
生成一份用于验证版面重建的双栏测试论文。

这不是随便造一个 PDF —— 它刻意包含了真实论文里所有会打垮「选区文本重建」的坑：
  · 双栏排版（左右栏在 PDF 内容流里交错）
  · 跨栏的标题和摘要
  · 页眉、页脚、页码
  · 行末连字符断词（pro- / posed）
  · 段落末行不满排
  · 图注、参考文献

用法：python scripts/make_sample_pdf.py
输出：samples/sample-paper.pdf
"""
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "samples" / "sample-paper.pdf"

PAGE_W, PAGE_H = 612, 792
MARGIN_X = 54
COL_GAP = 24
COL_W = (PAGE_W - MARGIN_X * 2 - COL_GAP) / 2  # 240
LEFT_X = MARGIN_X
RIGHT_X = MARGIN_X + COL_W + COL_GAP
FONT_SIZE = 9
LINE_H = 11
PARA_GAP = 6
CHARS_PER_LINE = 46

TITLE = "Retrieval-Augmented Instruction Tuning for Low-Resource Scientific Question Answering"

AUTHORS = "Wei Zhang, Yuki Tanaka, Marco Rossi"

AFFIL = "Institute for Language Technology, Example University"

ABSTRACT = (
    "Scientific question answering demands models that can ground their answers in "
    "dense technical prose while remaining robust to terminology that is rare in "
    "general-domain corpora. We study whether retrieval-augmented instruction tuning "
    "closes this gap without increasing inference cost. Our pipeline couples a "
    "sparse-dense hybrid retriever with an instruction-tuned decoder, and trains the "
    "decoder on a curriculum of progressively harder passages sampled from open-access "
    "preprints. On three benchmarks spanning biology, materials science, and computer "
    "science, the method improves exact-match accuracy by 7.4 points over a strong "
    "instruction-tuned baseline, with the largest gains on questions whose evidence "
    "spans multiple paragraphs. Ablations show that the curriculum matters more than "
    "the retriever choice, and that gains persist when the retriever is frozen. We "
    "release the training mixture and evaluation harness."
)

PARAGRAPHS = [
    "Large language models have become the default interface for scientific literature "
    "search, yet their answers remain unstable when a question requires synthesising "
    "evidence from several passages. A common failure mode is fluent but unsupported "
    "elaboration: the model produces a plausible mechanism, a plausible number, or a "
    "plausible citation, none of which appear in the source material. This is "
    "especially damaging in domains where readers cannot verify claims from background "
    "knowledge alone, such as materials synthesis or clinical dosage.",

    "Retrieval augmentation is the standard remedy. A retriever selects passages from a "
    "corpus, and the generator conditions on them. In practice, however, most pipelines "
    "are tuned on open-domain web text, where passages are short, redundant, and "
    "lexically close to the question. Scientific passages behave differently. They are "
    "long, densely nominalised, and rely on notation that the retriever has never seen "
    "during pretraining. A retriever trained on Wikipedia therefore underperforms "
    "exactly where the task is hardest.",

    "We argue that the mismatch is best addressed at training time rather than at "
    "retrieval time. Instead of building a better encoder, we expose the generator to "
    "increasingly difficult retrieval contexts during instruction tuning, so that it "
    "learns to ignore irrelevant passages and to stitch together evidence that is "
    "scattered across sections. The intuition is simple: a model that has only ever "
    "seen clean, well-matched context never learns to recover from a noisy one.",

    "Our curriculum has three stages. The first stage uses passages that contain the "
    "answer verbatim, which teaches the model to copy rather than paraphrase. The "
    "second stage introduces distractor passages drawn from the same section, forcing "
    "the model to discriminate between near-duplicate claims. The third stage samples "
    "distractors from the same document but a different section, which is where most "
    "realistic failures occur. We keep the retriever frozen throughout, so that any "
    "improvement is attributable to the generator.",

    "Evaluations use three held-out benchmarks. The biology set contains questions "
    "whose answers require combining a figure caption with the surrounding paragraph. "
    "The materials set is dominated by numeric claims and unit conversions. The "
    "computer science set includes questions about experimental setup that are "
    "answerable only from appendix material. We report exact match, token-level F1, "
    "and a citation-support score that measures whether the cited span actually "
    "entails the answer.",

    "Results show a consistent advantage over the instruction-tuned baseline. The "
    "improvement is largest on multi-paragraph questions, which is consistent with our "
    "hypothesis that the curriculum teaches evidence stitching. On single-paragraph "
    "questions the gain is modest but never negative. Notably, the frozen retriever "
    "means that the entire improvement comes from how the generator consumes context, "
    "which has practical consequences: existing retrieval infrastructure does not need "
    "to be retrained or re-indexed.",

    "Ablations isolate the contribution of each curriculum stage. Removing the third "
    "stage accounts for roughly half of the total gain, suggesting that section-level "
    "distractors are the most informative signal. Removing the second stage has a "
    "smaller effect but increases hallucinated numbers, presumably because the model "
    "never learns to compare competing numeric claims. The retriever choice matters "
    "less: swapping the hybrid retriever for a pure dense retriever changes accuracy by "
    "less than one point.",

    "We also examine failure cases. The dominant remaining error is unit confusion, "
    "where the model reports a correct number with an incorrect scale. A second cluster "
    "involves questions that require reading a table, which our pipeline serialises "
    "poorly. Both suggest that modality-aware retrieval, rather than better text "
    "retrieval, is the next bottleneck. We leave this to future work and release our "
    "harness so that others can measure progress on the same splits.",
]

CAPTION = (
    "Fig. 1. Curriculum stages and their effect on exact-match accuracy. Stage three "
    "contributes the largest single gain."
)

HEADER = "Proceedings of the 2026 Conference on Empirical Methods in Natural Language Processing"

REFERENCES = [
    "[1] A. Vaswani et al. Attention is all you need. In NeurIPS, 2017.",
    "[2] P. Lewis et al. Retrieval-augmented generation for knowledge-intensive NLP. In NeurIPS, 2020.",
    "[3] G. Izacard and E. Grave. Leveraging passage retrieval with generative models. In EACL, 2021.",
    "[4] S. Robertson and H. Zaragoza. The probabilistic relevance framework: BM25 and beyond. 2009.",
]


def esc(text: str) -> str:
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def hyphenate(text: str, width: int) -> list[str]:
    """按宽度断行，并在长词上使用行末连字符（真实论文的常见做法）。"""
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) <= width:
            current = candidate
            continue
        if current and len(word) > 7 and len(current) < width - 2:
            space = width - len(current) - 2
            if space >= 4:
                lines.append(current + " " + word[:space] + "-")
                current = word[space:]
                continue
        if current:
            lines.append(current)
        current = word
    if current:
        lines.append(current)
    return lines


def build_page_lines(body_pool: list[list[str]], page_index: int, total_pages: int):
    """返回 (x, y, size, text) 列表，坐标是 PDF 用户空间（原点左下）。"""
    items = []

    # 页眉
    items.append((MARGIN_X, PAGE_H - 40, 7.5, HEADER))
    # 页码
    items.append((PAGE_W / 2 - 4, 34, 8, str(page_index + 1)))

    y_cursor = PAGE_H - 74

    if page_index == 0:
        # 跨栏标题
        for line in hyphenate_plain(TITLE, 62):
            items.append((PAGE_W / 2 - len(line) * 4.6, y_cursor, 15, line))
            y_cursor -= 19
        y_cursor -= 4
        items.append((PAGE_W / 2 - len(AUTHORS) * 2.6, y_cursor, 10, AUTHORS))
        y_cursor -= 14
        items.append((PAGE_W / 2 - len(AFFIL) * 2.1, y_cursor, 8, AFFIL))
        y_cursor -= 22

        items.append((LEFT_X, y_cursor, 9, "Abstract"))
        y_cursor -= 13
        for line in hyphenate(ABSTRACT, 104):
            items.append((LEFT_X, y_cursor, FONT_SIZE, line))
            y_cursor -= LINE_H
        y_cursor -= 12

    # 两栏正文
    col_y = [y_cursor, y_cursor]
    col_index = 0
    used = [0, 0]

    while col_index < 2:
        paragraphs = body_pool[page_index * 2 + col_index] if page_index * 2 + col_index < len(body_pool) else []
        if not paragraphs:
            break
        x = LEFT_X if col_index == 0 else RIGHT_X
        y = col_y[col_index]
        for para in paragraphs:
            for line_no, line in enumerate(hyphenate(para, CHARS_PER_LINE)):
                if y < 70:
                    break
                items.append((x, y, FONT_SIZE, line))
                y -= LINE_H
            y -= PARA_GAP
            used[col_index] += 1
        col_y[col_index] = y
        col_index += 1

    # 第一页右栏底部塞一个图注，验证 caption 分类
    if page_index == 0:
        x = RIGHT_X
        y = col_y[1] - 6
        for line in hyphenate(CAPTION, CHARS_PER_LINE):
            if y < 60:
                break
            items.append((x, y, FONT_SIZE, line))
            y -= LINE_H

    return items


def hyphenate_plain(text: str, width: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) <= width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def chunk_paragraphs(paragraphs: list[str], columns: int) -> list[list[list[str]]]:
    """把段落分到 页 × 栏 的格子里。"""
    per_column: list[list[str]] = []
    bucket: list[str] = []
    for para in paragraphs:
        bucket.append(para)
        if len(bucket) == 2:
            per_column.append(bucket)
            bucket = []
    if bucket:
        per_column.append(bucket)

    # 补足到偶数个（每页两栏）
    while len(per_column) % 2 != 0:
        per_column.append([])

    pages: list[list[list[str]]] = []
    for i in range(0, len(per_column), 2):
        pages.append(per_column[i : i + 2])
    return pages


def make_pdf() -> None:
    body = list(PARAGRAPHS)
    # 第一页右栏底部/第二页插入图注段落
    pages_content = chunk_paragraphs(body, 2)

    # 让正文填满三页：段落循环复用
    while len(pages_content) < 3:
        pages_content.append([list(PARAGRAPHS[0:2]), list(PARAGRAPHS[2:4])])

    # 第三页结尾加参考文献（跨栏）
    total_pages = len(pages_content)

    contents: list[bytes] = []
    for page_index in range(total_pages):
        items = build_page_lines(
            [p for page in pages_content for p in page], page_index, total_pages
        )
        # 重新按页取段落，避免上面 flatten 的顺序错乱
        items = build_page_lines_page(pages_content, page_index, total_pages)
        stream = []
        for x, y, size, text in items:
            stream.append(
                f"BT /F1 {size} Tf 1 0 0 1 {x:.2f} {y:.2f} Tm ({esc(text)}) Tj ET"
            )
        contents.append("\n".join(stream).encode("latin-1"))

    # 参考文献放最后一页左栏底部 —— 为了简单，追加到最后一页内容流
    last = contents[-1].decode("latin-1").split("\n")
    y = 210
    last.append(f"BT /F1 9 Tf 1 0 0 1 {LEFT_X:.2f} {y:.2f} Tm (References) Tj ET")
    y -= 13
    for ref in REFERENCES:
        for line in hyphenate(ref, CHARS_PER_LINE):
            last.append(f"BT /F1 8 Tf 1 0 0 1 {LEFT_X:.2f} {y:.2f} Tm ({esc(line)}) Tj ET")
            y -= 10
        y -= 3
    contents[-1] = "\n".join(last).encode("latin-1")

    objects: list[bytes] = []

    def add(data: bytes) -> int:
        objects.append(data)
        return len(objects)

    # 1 catalog, 2 pages, 3..(2+n) page, then font, then contents
    n = total_pages
    catalog_id = 1
    pages_id = 2
    first_page = 3
    font_id = 3 + n
    first_content = 4 + n

    add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)
    kids = " ".join(f"{first_page + i} 0 R" for i in range(n))
    add(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode())

    for i in range(n):
        add(
            (
                f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
                f"/Resources << /Font << /F1 {font_id} 0 R >> >> "
                f"/Contents {first_content + i} 0 R >>"
            ).encode()
        )

    add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")

    for content in contents:
        add(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")

    pdf = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"

    xref_offset = len(pdf)
    pdf += f"xref\n0 {len(objects) + 1}\n".encode()
    pdf += b"0000000000 65535 f \n"
    for offset in offsets:
        pdf += f"{offset:010d} 00000 n \n".encode()
    pdf += (
        f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n"
    ).encode()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(bytes(pdf))
    print(f"wrote {OUT} ({len(pdf)} bytes, {n} pages)")


def build_page_lines_page(pages_content, page_index: int, total_pages: int):
    items = []
    items.append((MARGIN_X, PAGE_H - 40, 7.5, HEADER))
    items.append((PAGE_W / 2 - 4, 34, 8, str(page_index + 1)))

    y_cursor = PAGE_H - 74

    if page_index == 0:
        for line in hyphenate_plain(TITLE, 62):
            items.append((PAGE_W / 2 - len(line) * 4.6, y_cursor, 15, line))
            y_cursor -= 19
        y_cursor -= 4
        items.append((PAGE_W / 2 - len(AUTHORS) * 2.6, y_cursor, 10, AUTHORS))
        y_cursor -= 14
        items.append((PAGE_W / 2 - len(AFFIL) * 2.1, y_cursor, 8, AFFIL))
        y_cursor -= 22
        items.append((LEFT_X, y_cursor, 9, "Abstract"))
        y_cursor -= 13
        for line in hyphenate(ABSTRACT, 104):
            items.append((LEFT_X, y_cursor, FONT_SIZE, line))
            y_cursor -= LINE_H
        y_cursor -= 12

    page_cols = pages_content[page_index]

    for col_index in range(2):
        x = LEFT_X if col_index == 0 else RIGHT_X
        y = y_cursor
        for para in page_cols[col_index]:
            for line in hyphenate(para, CHARS_PER_LINE):
                if y < 70:
                    break
                items.append((x, y, FONT_SIZE, line))
                y -= LINE_H
            y -= PARA_GAP

    if page_index == 0:
        x = RIGHT_X
        y = 150
        for line in hyphenate(CAPTION, CHARS_PER_LINE):
            items.append((x, y, FONT_SIZE, line))
            y -= LINE_H

    return items


if __name__ == "__main__":
    make_pdf()
