attribute vec4 aPosition;
attribute vec3 aNormal;
attribute vec2 aTexCoord0;

uniform mat4 uProjectionMatrix;
uniform mat4 uViewMatrix;
uniform mat4 uModelMatrix;
uniform mat3 uNormalMatrix;
uniform float uPointSize;

varying vec3 ecNormal;
varying vec3 vWorldPosition;
varying vec2 vTexCoord0;

void main() {
    vec4 worldPosition = uModelMatrix * aPosition;
    vWorldPosition = vec3(worldPosition);
    vTexCoord0 = aTexCoord0;

    gl_Position = uProjectionMatrix * uViewMatrix * worldPosition;
    gl_PointSize = uPointSize;

    ecNormal = uNormalMatrix * aNormal;
}
