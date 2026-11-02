"""Compatibility entry point: storage now lives in PostgreSQL."""
from app.migrate_storage import main

if __name__ == '__main__':
    main()
