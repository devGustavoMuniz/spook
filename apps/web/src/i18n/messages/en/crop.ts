import type { MessageMap } from "../../types";

export const crop = {
  "crop.animatedAsIs":
    "This image is animated (animated WebP or PNG) and can't be cropped without losing the animation. It will be used whole, centered when displayed.",
  "crop.apply": "Apply",
  "crop.description": "Drag to position and use the zoom to choose the area that will be shown.",
  "crop.failed": "Couldn't crop the image. Try another one.",
  "crop.frameLabel": "Crop area: drag the image to position it",
  "crop.gifFallback":
    "This GIF is too large or complex to crop. We used the original file, centered.",
  "crop.gifNote":
    "Animated GIF: the crop applies to every frame and keeps the animation, without resizing.",
  "crop.keys":
    "Arrow keys move the image (Shift moves more), + and - change the zoom, Esc cancels.",
  "crop.loadFailed": "Couldn't open this image.",
  "crop.preview": "Preview",
  "crop.reset": "Reset framing",
  "crop.title.avatar": "Adjust avatar",
  "crop.title.banner": "Adjust banner",
  "crop.title.icon": "Adjust server icon",
  "crop.zoom": "Zoom",
} as const satisfies MessageMap;
