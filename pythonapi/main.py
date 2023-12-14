from pydantic import BaseModel
import requests
import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
import os
from datetime import datetime, timedelta

app = FastAPI()

class Code(BaseModel):
    code: str
    query: str

load_dotenv()

username = os.getenv('BGRID_USERNAME')
password = os.getenv('BGRID_PASSWORD')
endpoint = os.getenv('BGRID_ENDPOINT')

def get_external_data():
    url_actual = endpoint + "areas/actual"
    response = requests.get(url_actual, auth=(username, password))

    if response.status_code != 200:
        raise HTTPException(status_code=400, detail="Failed to get data from external API")

    return response.json()

dataset = get_external_data()
global sample_datetime 
sample_datetime = datetime.now()

@app.post("/execute")
def execute_code(code: Code):
    global output
    output = ""
    global sample_datetime
    # Get the current datetime
    current_datetime = datetime.now()

    # Calculate the difference between the current datetime and sample_datetime
    time_difference = current_datetime - sample_datetime
    # If the difference is more than 5 minutes, refresh the dataset
    print(time_difference.total_seconds() / 60)
    if time_difference > timedelta(minutes=5):
        dataset = get_external_data() 
        sample_datetime = datetime.now()
    try:
        print(code.code)
        exec(code.code)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    
    print({"status": code.query, "result": output})
    return {"status": code.query, "result": output}

@app.get("/")
def root():
    df = pd.DataFrame(dataset['data'])
    filtered_df = df[df['occupancy'] == 'available']
    return filtered_df['area_name'].to_json(orient='records')

@app.get("/area/{area_id}")
def get_area(area_id: int):
    df = pd.DataFrame(dataset['data'])
    area_data = df[df['area_id'] == area_id]
    return area_data.to_json(orient='records')
