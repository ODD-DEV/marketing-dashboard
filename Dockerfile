FROM python:3.11-slim
WORKDIR /app
COPY slack_order_notify.py ./
CMD ["python", "-u", "slack_order_notify.py"]
