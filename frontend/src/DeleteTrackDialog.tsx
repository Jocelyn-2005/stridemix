import { useEffect, useRef } from "react";
import { LoaderCircle, Trash2 } from "lucide-react";
import "./library.css";

interface DeleteTrackDialogProps {
  titles: string[];
  projectCount: number;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onClose: () => void;
}

export default function DeleteTrackDialog({
  titles,
  projectCount,
  busy,
  error,
  onConfirm,
  onClose,
}: DeleteTrackDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="delete-track-dialog"
      aria-labelledby="delete-track-title"
      aria-describedby="delete-track-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="delete-dialog-heading">
        <Trash2 size={26} aria-hidden="true" />
        <h2 id="delete-track-title">删除曲库素材</h2>
      </div>
      <p id="delete-track-description">
        将从这台电脑删除以下 {titles.length} 条素材
        {projectCount > 0 && `，同时从当前编排移除 ${projectCount} 条配乐`}。
        {titles.length > 1 && "其中包含依赖原始音源的适配版本。"}
      </p>
      <ul className="delete-track-list">
        {titles.map((title, index) => <li key={index}>{title}</li>)}
      </ul>
      {error && <p className="delete-dialog-error" role="alert">{error}</p>}
      <div className="delete-dialog-actions">
        <button className="secondary-button" disabled={busy} onClick={onClose} autoFocus>取消</button>
        <button className="delete-confirm-button" disabled={busy} onClick={onConfirm}>
          {busy ? <LoaderCircle size={19} className="spin" /> : <Trash2 size={19} />}
          {busy ? "正在删除" : "确认删除"}
        </button>
      </div>
    </dialog>
  );
}
