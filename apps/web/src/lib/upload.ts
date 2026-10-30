/**
 * PUT direto no storage (URL pré-assinada) via XMLHttpRequest, o único jeito de ter progresso de
 * upload (SPEC 5). Content-Type e tamanho precisam ser exatamente os assinados.
 */
export function putWithProgress(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`Falha no envio (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Falha de rede no envio"));
    xhr.onabort = () => reject(new Error("Envio cancelado"));
    xhr.send(file);
  });
}
