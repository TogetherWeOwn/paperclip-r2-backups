"""One nonblocking lock for revised backup, drill and local measurement writers."""
import contextlib
import fcntl
import os
from pathlib import Path
import stat


class LockError(Exception):
    pass


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Lease:
    def __init__(self, fd):
        self.fd = fd

    def mark_cleanup_pending(self):
        os.pwrite(self.fd, b"local-measurement-cleanup-pending\n", 0)
        os.fsync(self.fd)

    def reconcile(self):
        # Only the measurement owner, after verified client/plaintext cleanup.
        try:
            os.ftruncate(self.fd, 0)
            os.fsync(self.fd)
        except OSError:
            self.mark_cleanup_pending()
            raise


@contextlib.contextmanager
def operation_lock(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
                info.st_nlink != 1 or stat.S_IMODE(info.st_mode) & 0o077):
            raise LockError("operation lock must be a private owned regular file")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LockError("another backup/restore drill/measurement is running") from None
        if os.fstat(fd).st_size:
            raise LockError("operation lock requires authorized residual cleanup reconciliation")
        # A newly created lock pathname must survive before any capture starts.
        fsync_directory(Path(path).parent)
        yield Lease(fd)
    finally:
        os.close(fd)
