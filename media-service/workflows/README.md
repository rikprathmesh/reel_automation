# ComfyUI workflows

The media service drives a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) over its HTTP API using the API-format templates in this folder. If ComfyUI is unreachable or a workflow is missing, `/image` returns **503**. There is no placeholder fallback.

| File | Used by | Purpose |
|---|---|---|
| `txt2img.json` | `POST /image` with no references | SDXL text-to-image |
| `txt2img_ref.json` | `POST /image` with `reference_keys` | SDXL + IPAdapter Plus, so recurring characters keep their identity from their model sheet |
| `img2vid.json` | `POST /animate` with `mode: "comfyui"` | Stable Video Diffusion image-to-video; ComfyUI saves frames, ffmpeg assembles them |

## Required models (put them in your ComfyUI `models/` folders)

| Model | Folder | Env var |
|---|---|---|
| SDXL checkpoint, e.g. `sd_xl_base_1.0.safetensors` (or any SDXL fine-tune that fits your art style) | `models/checkpoints/` | `COMFYUI_CHECKPOINT` |
| SVD XT, `svd_xt.safetensors` (only for `img2vid`) | `models/checkpoints/` | `COMFYUI_SVD_CHECKPOINT` |
| IPAdapter Plus SDXL: `ip-adapter-plus_sdxl_vit-h.safetensors` | `models/ipadapter/` | — |
| CLIP Vision ViT-H: `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` | `models/clip_vision/` | — |

## Required custom nodes

- [ComfyUI_IPAdapter_plus](https://github.com/cubiq/ComfyUI_IPAdapter_plus) for `txt2img_ref.json` (`IPAdapterUnifiedLoader`, `IPAdapterAdvanced`). If you don't install it, delete `txt2img_ref.json`; reference-guided requests then use plain `txt2img`.

`txt2img.json` and `img2vid.json` use only core nodes.

## Tokens

String values are templated before submission: `{{PROMPT}}`, `{{NEGATIVE}}`, `{{SEED}}`, `{{WIDTH}}`, `{{HEIGHT}}`, `{{CHECKPOINT}}`, `{{SVD_CHECKPOINT}}`, `{{REF_IMAGE}}`, `{{INPUT_IMAGE}}`, `{{FRAMES}}`, `{{FPS}}`, `{{PREFIX}}`. A value that is exactly one token (for example `"{{SEED}}"`) is replaced by the typed value, so numbers stay numbers.

## Customising

Export any workflow from ComfyUI with **Save (API Format)**, put the tokens where you want them, and save it under the same file name. Images are generated at `IMAGE_GEN_WIDTH`×`IMAGE_GEN_HEIGHT` (default 768×1344, about 9:16) and scaled to the requested output size with ffmpeg.
