import os

import uvicorn
from dotenv import load_dotenv

load_dotenv()

PORT = int(os.getenv("PORT", "8000"))

if __name__ == "__main__":
    dev = os.getenv("ENV", "development") == "development"
    uvicorn.run(
        "app.main:app",
        # nginx가 localhost로 프록시하므로 루프백에만 엽니다 - 0.0.0.0이면
        # 방화벽이 열려 있을 때 TLS·프록시를 우회해 포트로 직접 접속됩니다.
        # LAN에 직접 열어야 하면 .env에 HOST=0.0.0.0.
        host=os.getenv("HOST", "127.0.0.1"),
        port=PORT,
        reload=dev,
        # 코드 폴더만 감시합니다. 기본값(작업 폴더 전체)이면 instance/records에
        # 서명·영수증이 저장될 때마다 서버가 재시작되어, 저장 직후 신청서를
        # 열면 그 재시작 틈에 502가 났습니다.
        reload_dirs=["app"] if dev else None,
    )
