from copy import deepcopy

import pytest

from trellis.curriculum import outline_paths, preserves_outline, source_roadmap_paths


GPU_GOAL = """## Phase 1: Hardware & Compute Architecture

* GPU Architecture: Stream Multiprocessors (SMs), CUDA cores, Tensor Cores, and how parallel processing handles matrix multiplication.
* Memory Hierarchy: High Bandwidth Memory (HBM), SRAM, L1/L2 caches, and the difference between compute-bound and memory-bound operations.
* Compute Precisions: Quantization representations, including FP32, FP16, BF16, INT8, INT4, and FP4, and how they affect throughput and accuracy.

## Phase 2: Kernel Optimization & Low-Level Programming

* CUDA Programming Foundations: Writing custom CUDA kernels using threads, blocks, grids, and managing shared memory to eliminate memory bottlenecks.
* Memory Layouts & Tiling: Understanding Row-Major vs. Column-Major layouts, coalesced memory access, and matrix tiling algorithms.
* Fused Operations: How operators like FlashAttention fuse memory-bound operations (Softmax) into compute-bound blocks to drastically reduce HBM read/writes.

## Phase 3: Model Compilers & Execution Runtimes

* Graph Compilation: How frameworks convert Python code into optimized computation graphs (PyTorch 2.0 torch.compile, Triton, XLA).
* Intermediate Representations (IR): Understanding how code is lowered from high-level Python down to hardware-specific machine code.
* Deep Learning Runtimes: Optimizing static and dynamic graphs using engines like TensorRT, ONNX Runtime, or vLLM.

## Phase 4: Distributed Training & Inference Infrastructure

* Distributed Communication Primitives: How multiple GPUs communicate using All-Reduce, All-Gather, and Reduce-Scatter via NCCL.
* Parallelism Strategies: Implementing Data Parallelism (DDP), Tensor Parallelism (Megatron-LM), Pipeline Parallelism, and ZeRO (Zero Redundancy Optimizer).
* Serving Optimizations: Advanced inference mechanics like PagedAttention (managing KV-cache fragmentation), continuous batching, and speculative decoding.
"""

GPU_PHASES = [
    ("Phase 1: Hardware & Compute Architecture", [
        "GPU Architecture", "Memory Hierarchy", "Compute Precisions",
    ]),
    ("Phase 2: Kernel Optimization & Low-Level Programming", [
        "CUDA Programming Foundations", "Memory Layouts & Tiling", "Fused Operations",
    ]),
    ("Phase 3: Model Compilers & Execution Runtimes", [
        "Graph Compilation", "Intermediate Representations (IR)", "Deep Learning Runtimes",
    ]),
    ("Phase 4: Distributed Training & Inference Infrastructure", [
        "Distributed Communication Primitives", "Parallelism Strategies", "Serving Optimizations",
    ]),
]


def test_full_gpu_goal_retains_all_four_phases_and_twelve_topics():
    expected = []
    for phase, topics in GPU_PHASES:
        expected.append((phase,))
        expected.extend((phase, topic) for topic in topics)

    assert outline_paths(GPU_GOAL) == expected
    assert len(expected) == 16


def test_heading_levels_nested_lists_and_inline_formatting_are_preserved():
    text = """# **GPU** course
## [Hardware](https://example.com)
1. **Architecture:** an overview
   - `SMs`
   - Cores: parallel processing
2. Memory

   This paragraph describes the item; it is not another topic.

   - Cache
### Precision
* BF16
## Runtime
* Compilation
"""
    assert outline_paths(text) == [
        ("GPU course",),
        ("GPU course", "Hardware"),
        ("GPU course", "Hardware", "Architecture"),
        ("GPU course", "Hardware", "Architecture", "SMs"),
        ("GPU course", "Hardware", "Architecture", "Cores"),
        ("GPU course", "Hardware", "Memory"),
        ("GPU course", "Hardware", "Memory", "Cache"),
        ("GPU course", "Hardware", "Precision"),
        ("GPU course", "Hardware", "Precision", "BF16"),
        ("GPU course", "Runtime"),
        ("GPU course", "Runtime", "Compilation"),
    ]


def test_plain_prose_and_code_blocks_do_not_create_topic_anchors():
    assert outline_paths("Learn GPU programming, including memory and parallel execution.") == []
    assert outline_paths("```markdown\n## Example heading\n* Example topic\n```") == []


def test_step_and_arrow_outline_keeps_topics_nested_without_turning_prose_into_nodes():
    text = r"""Step 1: Master the Fundamentals
→ LLMs
→ Embeddings
→ Retrieval
→ Prompting
→ Fine-Tuning
Not just how they work.
Why they work.
And where they fail.

Step 2: Learn System Design
→ RAG Architectures
→ Agent Workflows
→ Memory Systems
→ Evaluation Pipelines
→ Production Deployments
Because AI interviews increasingly test systems, not components.

Step 3: Study Failure Modes
→ Hallucinations
→ Retrieval Misses
→ Context Overflows
→ Cost Explosions
→ Latency Issues
Great engineers understand failures better than features.

Step 4: Learn Evaluation
This is where most candidates struggle.
→ Precision\@K
→ Recall\@K
→ Ground Truth Datasets
→ Human Evaluation
→ LLM-as-a-Judge
If you can't measure quality, you can't improve quality.

Step 5: Practice Real Interview Questions
Not theoretical questions.
The kind of questions that force you to think:
"What would you do?"
"Why did you choose that?"
"What trade-offs are you making?"
"""
    steps = [
        ("Step 1: Master the Fundamentals", [
            "LLMs", "Embeddings", "Retrieval", "Prompting", "Fine-Tuning",
        ]),
        ("Step 2: Learn System Design", [
            "RAG Architectures", "Agent Workflows", "Memory Systems",
            "Evaluation Pipelines", "Production Deployments",
        ]),
        ("Step 3: Study Failure Modes", [
            "Hallucinations", "Retrieval Misses", "Context Overflows",
            "Cost Explosions", "Latency Issues",
        ]),
        ("Step 4: Learn Evaluation", [
            "Precision@K", "Recall@K", "Ground Truth Datasets",
            "Human Evaluation", "LLM-as-a-Judge",
        ]),
        ("Step 5: Practice Real Interview Questions", []),
    ]
    expected = []
    for step, topics in steps:
        expected.append((step,))
        expected.extend((step, topic) for topic in topics)

    assert outline_paths(text) == expected
    assert len(expected) == 25


def test_long_freeform_items_are_left_for_semantic_review():
    long_text = "Long explanatory text " * 20
    text = f"""## Hardware
* Architecture: {long_text}
* {long_text}
  * Child of an unrecognized item
* Memory

An ordinary paragraph is not a topic.
"""
    assert outline_paths(text) == [
        ("Hardware",), ("Hardware", "Architecture"), ("Hardware", "Memory"),
    ]


@pytest.fixture
def gpu_nodes():
    return [
        {"title": phase, "children": [{"title": title, "children": []} for title in topics]}
        for phase, topics in GPU_PHASES
    ]


def test_inferred_children_and_siblings_do_not_displace_requested_structure(gpu_nodes):
    nodes = deepcopy(gpu_nodes)
    nodes.insert(0, {"title": "Orientation", "children": []})
    nodes[2]["children"].insert(1, {"title": "Kernel debugging", "children": []})
    nodes[3]["children"][1]["children"] = [{"title": "Lowering passes", "children": []}]

    assert preserves_outline(gpu_nodes, outline_paths(GPU_GOAL))
    assert preserves_outline(nodes, outline_paths(GPU_GOAL))


@pytest.mark.parametrize("change", ["drop", "reparent", "reorder", "duplicate", "wrap"])
def test_changed_middle_topic_is_rejected(gpu_nodes, change):
    nodes = deepcopy(gpu_nodes)
    topics = nodes[1]["children"]
    if change == "drop":
        topics.pop(1)
    elif change == "reparent":
        nodes[2]["children"].append(topics.pop(1))
    elif change == "reorder":
        topics[1], topics[2] = topics[2], topics[1]
    elif change == "duplicate":
        topics.append(deepcopy(topics[1]))
    else:
        topics[1] = {"title": "Extra grouping", "children": [topics[1]]}

    assert not preserves_outline(nodes, outline_paths(GPU_GOAL))


def test_reordered_phases_are_rejected(gpu_nodes):
    gpu_nodes[1], gpu_nodes[2] = gpu_nodes[2], gpu_nodes[1]
    assert not preserves_outline(gpu_nodes, outline_paths(GPU_GOAL))


def test_duplicate_required_paths_cannot_be_satisfied_by_duplicate_nodes():
    assert not preserves_outline(
        [{"title": "Memory"}, {"title": "Memory"}], [("Memory",), ("Memory",)],
    )


def test_same_topic_label_is_allowed_under_distinct_phases():
    nodes = [
        {"title": "Hardware", "children": [{"title": "Memory"}]},
        {"title": "Runtime", "children": [{"title": "Memory"}]},
    ]
    required = [("Hardware",), ("Hardware", "Memory"), ("Runtime",), ("Runtime", "Memory")]
    assert preserves_outline(nodes, required)


def test_unstructured_goal_has_no_explicit_paths_to_enforce():
    assert preserves_outline([{"title": "GPU foundations"}], [])


def test_source_roadmap_reads_markdown_headings_without_body_bullets():
    article = """# System Design
## Networking
- A supporting bullet, not a chapter
### DNS
## Storage
"""
    assert source_roadmap_paths(article) == [
        ("System Design",), ("System Design", "Networking"),
        ("System Design", "Networking", "DNS"), ("System Design", "Storage"),
    ]


def test_source_roadmap_reads_numbered_sections_from_older_plain_text_articles():
    article = """An introduction to the concepts.
1. Client-Server Architecture
The client talks to a server.
- This is an explanatory bullet.
2. IP Address
More explanatory prose.
3. DNS
More prose.
"""
    assert source_roadmap_paths(article) == [
        ("Client-Server Architecture",), ("IP Address",), ("DNS",),
    ]
