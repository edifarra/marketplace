import Image from "next/image";
import { evidenceUrl } from "./shopee-presentation";
import styles from "./cases.module.css";
type Row = Record<string, any>;
export function CaseEvidence({ evidence }: { evidence: Row[] }) {
  if (!evidence.length) return <p className="muted">Nenhuma evidência do comprador disponível nos dados locais.</p>;
  return <div><h3>Evidências do comprador</h3><div className={styles.evidenceGrid}>{evidence.map((item, index) => {
    const url = evidenceUrl(item.reference);
    return <div key={item.id || index}>{!url ? <p className="muted">{item.media_type === "video" ? "Vídeo" : "Evidência"} {index + 1}: referência sem URL visualizável.</p> : <>{item.media_type === "image" ? <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Ampliar fotografia ${index + 1}`}><Image unoptimized src={url} width={160} height={120} alt={`Evidência do comprador ${index + 1}`} loading="lazy"/></a> : item.media_type === "video" ? <video controls preload="none" src={url} aria-label={`Vídeo do comprador ${index + 1}`}/> : null}<a href={url} target="_blank" rel="noopener noreferrer">{item.media_type === "image" ? "Ampliar fotografia" : "Abrir evidência"} {index + 1}</a></>}</div>;
  })}</div></div>;
}
