import { requestUpload } from "@spook/shared";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { putWithProgress } from "@/lib/upload";
import { UploadQueue } from "./upload-queue";

/** Fila de anexos do composer do canal; trocar de canal descarta os pendentes. */
export function useUploadQueue(channelId: string) {
  const queue = useMemo(
    () =>
      new UploadQueue(channelId, {
        requestUpload: (id, data) => requestUpload(id, data),
        put: putWithProgress,
        createPreviewUrl: (f) => URL.createObjectURL(f),
        revokePreviewUrl: (u) => URL.revokeObjectURL(u),
      }),
    [channelId],
  );
  useEffect(() => () => queue.clear(), [queue]);
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  return { queue, items };
}
