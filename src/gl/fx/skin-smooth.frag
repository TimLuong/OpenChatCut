#version 300 es
precision highp float;
// Face beauty: edge-preserving (bilateral) smoothing applied only where the
// pixel colour falls in the human skin range (YCbCr), plus an optional soft
// lift. Eyes, hair, lips edges and the background keep their detail.
uniform sampler2D u_input;
uniform float u_smooth;
uniform float u_radius;
uniform float u_brighten;
uniform vec2 u_resolution;
in vec2 v_texCoord;
out vec4 fragColor;

float skinMask(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  float cb = 0.5 - 0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b;
  float cr = 0.5 + 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b;
  float inCb = smoothstep(0.28, 0.33, cb) * (1.0 - smoothstep(0.49, 0.54, cb));
  float inCr = smoothstep(0.50, 0.54, cr) * (1.0 - smoothstep(0.67, 0.71, cr));
  return inCb * inCr * smoothstep(0.10, 0.22, y);
}

void main() {
  vec4 center = texture(u_input, v_texCoord);
  float mask = skinMask(center.rgb);
  if (mask <= 0.001 || u_smooth <= 0.0) {
    fragColor = center;
    return;
  }
  vec2 step = (u_radius * 0.5) / max(u_resolution, vec2(1.0));
  vec3 sum = vec3(0.0);
  float weights = 0.0;
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      vec3 s = texture(u_input, v_texCoord + vec2(float(dx), float(dy)) * step).rgb;
      float spatial = exp(-float(dx * dx + dy * dy) / 8.0);
      vec3 d = s - center.rgb;
      float range = exp(-dot(d, d) / 0.0128);
      float w = spatial * range;
      sum += s * w;
      weights += w;
    }
  }
  vec3 smoothed = sum / max(weights, 1e-4);
  float amount = clamp(u_smooth, 0.0, 1.0) * mask;
  vec3 color = mix(center.rgb, smoothed, amount);
  color += u_brighten * mask * (1.0 - color) * 0.5;
  fragColor = vec4(clamp(color, 0.0, 1.0), center.a);
}
