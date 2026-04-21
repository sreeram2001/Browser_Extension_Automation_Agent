"""
RAG Evaluation using RAGAS + Gemini as LLM judge.

Install:
    pip install ragas langchain-google-genai pinecone python-dotenv

Run:
    python eval/evaluate.py
"""

import json, os, sys, warnings
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")
warnings.filterwarnings("ignore")

QUESTIONS_FILE = Path(__file__).parent / "questions.json"
GEMINI_API_KEY  = os.environ["GEMINI_API_KEY"]
PINECONE_API_KEY = os.environ["PINECONE_API_KEY"]
INDEX_NAME      = os.environ.get("PINECONE_INDEX", "sonic-rag")

from pinecone import Pinecone
from ragas import EvaluationDataset, evaluate
from ragas.dataset_schema import SingleTurnSample
from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import LangchainEmbeddingsWrapper
from ragas.metrics import Faithfulness, AnswerRelevancy, ContextRecall, ContextPrecision
from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings

# ── clients ──────────────────────────────────────────────────────────────────
pc    = Pinecone(api_key=PINECONE_API_KEY)
index = pc.Index(INDEX_NAME)

gemini    = ChatGoogleGenerativeAI(model="gemini-2.5-flash", google_api_key=GEMINI_API_KEY)
ragas_llm = LangchainLLMWrapper(gemini)
ragas_emb = LangchainEmbeddingsWrapper(
    GoogleGenerativeAIEmbeddings(model="models/text-embedding-004", google_api_key=GEMINI_API_KEY)
)

# ── RAG helpers ───────────────────────────────────────────────────────────────
def query_rag(question: str, top_k: int = 5) -> list[str]:
    results = index.search(
        namespace="__default__",
        query={"inputs": {"text": question}, "top_k": top_k},
    )
    hits = results.get("result", {}).get("hits", [])
    return [h["fields"]["text"] for h in hits if h.get("fields", {}).get("text")]


def generate_answer(question: str, contexts: list[str]) -> str:
    context_text = "\n\n".join(contexts)
    prompt = (
        "Answer the question based only on the context below.\n\n"
        f"Context:\n{context_text}\n\n"
        f"Question: {question}"
    )
    return gemini.invoke(prompt).content


# ── main ──────────────────────────────────────────────────────────────────────
def main():
    with open(QUESTIONS_FILE) as f:
        test_cases = json.load(f)

    samples = []
    print(f"Retrieving for {len(test_cases)} questions...\n")

    for tc in test_cases:
        q         = tc["question"]
        reference = tc.get("ground_truth") or tc.get("answer", "")

        print(f"  Q: {q[:80]}...")
        contexts = query_rag(q)

        if not contexts:
            print("  ✗ no chunks returned\n")
            continue

        response = generate_answer(q, contexts)
        samples.append(SingleTurnSample(
            user_input=q,
            retrieved_contexts=contexts,
            response=response,
            reference=reference,
        ))
        print(f"  ✓ {len(contexts)} chunks retrieved\n")

    if not samples:
        print("No results to evaluate.")
        return

    print(f"Running RAGAS on {len(samples)} samples...\n")
    results = evaluate(
        dataset=EvaluationDataset(samples=samples),
        metrics=[
            Faithfulness(llm=ragas_llm),
            AnswerRelevancy(llm=ragas_llm, embeddings=ragas_emb),
            ContextRecall(llm=ragas_llm),
            ContextPrecision(llm=ragas_llm),
        ],
    )

    df = results.to_pandas()
    print("\n" + "=" * 50)
    print("RAGAS SCORES")
    print("=" * 50)
    print(df.to_string())
    print("\nMean scores:")
    for col in ["faithfulness", "answer_relevancy", "context_recall", "context_precision"]:
        if col in df.columns:
            print(f"  {col:25}: {df[col].mean():.3f}")

    out = Path(__file__).parent / "results.csv"
    df.to_csv(out, index=False)
    print(f"\nSaved to {out}")


if __name__ == "__main__":
    main()
