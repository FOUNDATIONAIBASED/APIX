/*
 * Stub for JDK 9+ javax.annotation.processing.Generated — not on the Android compile classpath.
 * Dagger's annotation processor emits this import when running on a modern JDK; this satisfies javac.
 * See: https://github.com/google/auto/blob/master/common/src/main/java/com/google/auto/common/GeneratedAnnotations.java
 */
package javax.annotation.processing;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Documented
@Retention(RetentionPolicy.SOURCE)
@Target({ElementType.TYPE, ElementType.METHOD, ElementType.CONSTRUCTOR, ElementType.FIELD,
        ElementType.PARAMETER, ElementType.LOCAL_VARIABLE, ElementType.ANNOTATION_TYPE,
        ElementType.PACKAGE})
public @interface Generated {
    String[] value();

    String comments() default "";
}
