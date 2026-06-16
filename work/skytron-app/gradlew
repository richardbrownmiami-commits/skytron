#!/bin/sh
# Gradle startup script for POSIX systems
DIRNAME=$(dirname "$0")
APP_BASE_NAME=$(basename "$0")
DEFAULT_JVM_OPTS="-Xmx64m -Xms64m"
MAX_FD="maximum"
warn () { echo "$*"; }
die () { echo "$*"; exit 1; }
CLASSPATH=$DIRNAME/gradle/wrapper/gradle-wrapper.jar
JAVACMD="java"
if [ -n "$JAVA_HOME" ] ; then
    JAVACMD="$JAVA_HOME/bin/java"
fi
exec "$JAVACMD" $DEFAULT_JVM_OPTS $JAVA_OPTS $GRADLE_OPTS \
    "-Dorg.gradle.appname=$APP_BASE_NAME" \
    -classpath "$CLASSPATH" \
    org.gradle.wrapper.GradleWrapperMain "$@"
