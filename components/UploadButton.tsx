import { useState } from "react";
import { toast } from "sonner";

export function UploadButton({ onUpload }: { onUpload: (fileId: string, name: string) => void }) {
  const [loading, setLoading] = useState(false);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);

    try {
      // Отправляем файл на наш API route для загрузки в Gemini
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const json = await res.json();
      if (json.fileId) {
        onUpload(json.fileId, file.name);
      } else {
        toast.error('Ошибка загрузки', { description: json?.error || 'Не удалось загрузить файл.' });
      }
    } catch (err) {
      console.error("Ошибка при загрузке файла:", err);
      toast.error('Ошибка загрузки', { description: String(err) });
    } finally {
      setLoading(false);
      // Очищаем значение input'а для возможности выбрать один и тот же файл снова
      e.target.value = '';
    }
  }

  return (
    <label className="cursor-pointer px-3 py-2 rounded-md bg-primary text-black hover:bg-primary/90">
      {loading ? "Загрузка..." : "📎 Прикрепить файл"}
      <input type="file" className="hidden" onChange={handleFileSelect} />
    </label>
  );
}
