"""Source-only listener check. No HIMS API request is made."""
import json
import traceback


def diagnose():
    import main

    try:
        for modality, value in main.ris_dict.items():
            port = json.loads(value)['port']
            print(f'Checking {modality.upper()} port {port} ...', flush=True)
            main.create_worklist_server(modality.upper(), port)
        print('PASS: All configured listeners can start. No HIMS requests were made.')
    finally:
        for server in main.ae_instances.values():
            server.shutdown()
            server.server_close()
        main.ae_instances.clear()


if __name__ == '__main__':
    try:
        diagnose()
    except Exception:
        traceback.print_exc()
        raise SystemExit(1)
