import { z } from 'zod';

/**
 * Convert a JSON Schema object to a Zod schema.
 * Handles the subset of JSON Schema used by skill tool parameters.
 */
export function jsonSchemaToZod(schema: {
  type: 'object';
  properties: Record<string, any>;
  required?: string[];
}): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(schema.properties || {})) {
    const p = prop as any;
    let zodType: z.ZodTypeAny;

    switch (p.type) {
      case 'string':
        if (p.enum && Array.isArray(p.enum)) {
          zodType = z.enum(p.enum as [string, ...string[]]);
        } else {
          let text = z.string();
          if (Number.isInteger(p.minLength)) text = text.min(p.minLength);
          if (Number.isInteger(p.maxLength)) text = text.max(p.maxLength);
          zodType = text;
        }
        break;
      case 'number':
      case 'integer':
        let number = p.type === 'integer' ? z.number().int() : z.number();
        if (Number.isFinite(p.minimum)) number = number.min(p.minimum);
        if (Number.isFinite(p.maximum)) number = number.max(p.maximum);
        zodType = number;
        break;
      case 'boolean':
        zodType = z.boolean();
        break;
      case 'array':
        if (p.items) {
          const itemType = mapSimpleType(p.items.type);
          zodType = z.array(itemType);
        } else {
          zodType = z.array(z.any());
        }
        break;
      case 'object':
        zodType = z.record(z.any());
        break;
      default:
        zodType = z.any();
    }

    // Numeric/boolean enums must keep their actual types; string coercion would
    // silently bypass e.g. fixed hot windows or explicit write confirmation.
    if (p.type !== 'string' && Array.isArray(p.enum)) {
      const allowed = [...p.enum];
      zodType = zodType.refine(value => allowed.some(item => item === value), 'Value is not in the allowed enum');
    }
    if (p.description) {
      zodType = zodType.describe(p.description);
    }

    // Mark as optional if not in required array
    const isRequired = schema.required?.includes(key);
    if (!isRequired) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return z.object(shape);
}

function mapSimpleType(type: string): z.ZodTypeAny {
  switch (type) {
    case 'string': return z.string();
    case 'number':
    case 'integer': return z.number();
    case 'boolean': return z.boolean();
    default: return z.any();
  }
}
