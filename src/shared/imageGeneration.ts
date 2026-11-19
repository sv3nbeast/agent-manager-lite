import { z } from 'zod'

export const DEFAULT_IMAGE_GENERATION_MODEL = 'gpt-image-2.6-sunburst'

// Provider model IDs are configurable, not a versioned allowlist. Reject only
// empty/oversized IDs and whitespace/control characters that cannot form an ID.
export const imageGenerationModelSchema = z.string().trim().min(1, '请输入图片模型 ID').max(200, '图片模型 ID 最多 200 个字符')
  .regex(/^[^\s\u0000-\u001f\u007f]+$/u, '图片模型 ID 不能包含空白或控制字符')
