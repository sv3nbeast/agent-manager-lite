// APFS copy-on-write snapshot from already verified file/directory descriptors.
// No source path is reopened, and the source is never modified or signalled.
#include <sys/clonefile.h>
#include <sys/stat.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  struct stat source, directory;
  if (argc != 2 || !argv[1][0] || strchr(argv[1], '/') ||
      !strcmp(argv[1], ".") || !strcmp(argv[1], "..") ||
      fstat(3, &source) || !S_ISREG(source.st_mode) ||
      fstat(4, &directory) || !S_ISDIR(directory.st_mode)) return 1;
  if (fclonefileat(3, 4, argv[1], 0)) {
    // Ordinary copies can still work on other volumes, but cannot promise a
    // stable snapshot of an actively rewritten file.
    if (errno == ENOTSUP || errno == EXDEV || errno == ENOSYS) return 2;
    return 1;
  }
  return 0;
}
