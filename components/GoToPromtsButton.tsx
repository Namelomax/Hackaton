"use client";
import { useRouter } from "next/navigation";

export default function GoToPromtsButton() {
  const router = useRouter();

  return (
    <button
      onClick={() => router.push("/promts")}
      className="bg-primary text-black px-4 py-2 rounded hover:bg-primary/90 transition"
    >
      Перейти к странице промтов
    </button>
  );
}
