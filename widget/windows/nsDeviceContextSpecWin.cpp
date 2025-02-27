/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/ArrayUtils.h"

#include "nsDeviceContextSpecWin.h"
#include "prmem.h"

#include <winspool.h>

#include <tchar.h>

#include "nsAutoPtr.h"
#include "nsIWidget.h"

#include "nsTArray.h"
#include "nsIPrintSettingsWin.h"

#include "nsString.h"
#include "nsCRT.h"
#include "nsIServiceManager.h"
#include "nsReadableUtils.h"
#include "nsStringEnumerator.h"

#include "gfxPDFSurface.h"
#include "gfxWindowsSurface.h"

#include "nsIFileStreams.h"
#include "nsIWindowWatcher.h"
#include "nsIDOMWindow.h"
#include "mozilla/Services.h"

// For NS_CopyNativeToUnicode
#include "nsNativeCharsetUtils.h"

// File Picker
#include "nsIFile.h"
#include "nsIFilePicker.h"
#include "nsIStringBundle.h"
#define NS_ERROR_GFX_PRINTER_BUNDLE_URL "chrome://global/locale/printing.properties"

#include "mozilla/gfx/Logging.h"

#include "mozilla/Logging.h"
PRLogModuleInfo * kWidgetPrintingLogMod = PR_NewLogModule("printing-widget");
#define PR_PL(_p1)  MOZ_LOG(kWidgetPrintingLogMod, mozilla::LogLevel::Debug, _p1)

using namespace mozilla;

static const wchar_t kDriverName[] =  L"WINSPOOL";

//----------------------------------------------------------------------------------
// The printer data is shared between the PrinterEnumerator and the nsDeviceContextSpecWin
// The PrinterEnumerator creates the printer info
// but the nsDeviceContextSpecWin cleans it up
// If it gets created (via the Page Setup Dialog) but the user never prints anything
// then it will never be delete, so this class takes care of that.
class GlobalPrinters {
public:
  static GlobalPrinters* GetInstance() { return &mGlobalPrinters; }
  ~GlobalPrinters() { FreeGlobalPrinters(); }

  void FreeGlobalPrinters();

  bool         PrintersAreAllocated() { return mPrinters != nullptr; }
  LPWSTR       GetItemFromList(int32_t aInx) { return mPrinters?mPrinters->ElementAt(aInx):nullptr; }
  nsresult     EnumeratePrinterList();
  void         GetDefaultPrinterName(nsString& aDefaultPrinterName);
  uint32_t     GetNumPrinters() { return mPrinters?mPrinters->Length():0; }

protected:
  GlobalPrinters() {}
  nsresult EnumerateNativePrinters();
  void     ReallocatePrinters();

  static GlobalPrinters    mGlobalPrinters;
  static nsTArray<LPWSTR>* mPrinters;
};
//---------------
// static members
GlobalPrinters    GlobalPrinters::mGlobalPrinters;
nsTArray<LPWSTR>* GlobalPrinters::mPrinters = nullptr;

struct AutoFreeGlobalPrinters
{
  ~AutoFreeGlobalPrinters() {
    GlobalPrinters::GetInstance()->FreeGlobalPrinters();
  }
};

//----------------------------------------------------------------------------------
nsDeviceContextSpecWin::nsDeviceContextSpecWin()
{
  mDriverName    = nullptr;
  mDeviceName    = nullptr;
  mDevMode       = nullptr;

}


//----------------------------------------------------------------------------------

NS_IMPL_ISUPPORTS(nsDeviceContextSpecWin, nsIDeviceContextSpec)

nsDeviceContextSpecWin::~nsDeviceContextSpecWin()
{
  SetDeviceName(nullptr);
  SetDriverName(nullptr);
  SetDevMode(nullptr);

  nsCOMPtr<nsIPrintSettingsWin> psWin(do_QueryInterface(mPrintSettings));
  if (psWin) {
    psWin->SetDeviceName(nullptr);
    psWin->SetDriverName(nullptr);
    psWin->SetDevMode(nullptr);
  }

  // Free them, we won't need them for a while
  GlobalPrinters::GetInstance()->FreeGlobalPrinters();
}


//------------------------------------------------------------------
// helper
static char16_t * GetDefaultPrinterNameFromGlobalPrinters()
{
  nsAutoString printerName;
  GlobalPrinters::GetInstance()->GetDefaultPrinterName(printerName);
  return ToNewUnicode(printerName);
}

//----------------------------------------------------------------------------------
NS_IMETHODIMP nsDeviceContextSpecWin::Init(nsIWidget* aWidget,
                                           nsIPrintSettings* aPrintSettings,
                                           bool aIsPrintPreview)
{
  mPrintSettings = aPrintSettings;

  nsresult rv = NS_ERROR_GFX_PRINTER_NO_PRINTER_AVAILABLE;
  if (aPrintSettings) {
    nsCOMPtr<nsIPrintSettingsWin> psWin(do_QueryInterface(aPrintSettings));
    if (psWin) {
      char16_t* deviceName;
      char16_t* driverName;
      psWin->GetDeviceName(&deviceName); // creates new memory (makes a copy)
      psWin->GetDriverName(&driverName); // creates new memory (makes a copy)

      LPDEVMODEW devMode;
      psWin->GetDevMode(&devMode);       // creates new memory (makes a copy)

      if (deviceName && driverName && devMode) {
        // Scaling is special, it is one of the few
        // devMode items that we control in layout
        if (devMode->dmFields & DM_SCALE) {
          double scale = double(devMode->dmScale) / 100.0f;
          if (scale != 1.0) {
            aPrintSettings->SetScaling(scale);
            devMode->dmScale = 100;
          }
        }

        SetDeviceName(deviceName);
        SetDriverName(driverName);
        SetDevMode(devMode);

        // clean up
        free(deviceName);
        free(driverName);

        return NS_OK;
      } else {
        PR_PL(("***** nsDeviceContextSpecWin::Init - deviceName/driverName/devMode was NULL!\n"));
        if (deviceName) free(deviceName);
        if (driverName) free(driverName);
        if (devMode) ::HeapFree(::GetProcessHeap(), 0, devMode);
      }
    }
  } else {
    PR_PL(("***** nsDeviceContextSpecWin::Init - aPrintSettingswas NULL!\n"));
  }

  // Get the Print Name to be used
  char16_t * printerName = nullptr;
  if (mPrintSettings) {
    mPrintSettings->GetPrinterName(&printerName);
  }

  // If there is no name then use the default printer
  if (!printerName || (printerName && !*printerName)) {
    printerName = GetDefaultPrinterNameFromGlobalPrinters();
  }

  NS_ASSERTION(printerName, "We have to have a printer name");
  if (!printerName || !*printerName) return rv;
 
  return GetDataFromPrinter(printerName, mPrintSettings);
}

//----------------------------------------------------------
// Helper Function - Free and reallocate the string
static void CleanAndCopyString(wchar_t*& aStr, const wchar_t* aNewStr)
{
  if (aStr != nullptr) {
    if (aNewStr != nullptr && wcslen(aStr) > wcslen(aNewStr)) { // reuse it if we can
      wcscpy(aStr, aNewStr);
      return;
    } else {
      PR_Free(aStr);
      aStr = nullptr;
    }
  }

  if (nullptr != aNewStr) {
    aStr = (wchar_t *)PR_Malloc(sizeof(wchar_t)*(wcslen(aNewStr) + 1));
    wcscpy(aStr, aNewStr);
  }
}

NS_IMETHODIMP nsDeviceContextSpecWin::GetSurfaceForPrinter(gfxASurface **surface)
{
  NS_ASSERTION(mDevMode, "DevMode can't be NULL here");

  *surface = nullptr;
  RefPtr<gfxASurface> newSurface;

  int16_t outputFormat = 0;
  if (mPrintSettings) {
    mPrintSettings->GetOutputFormat(&outputFormat);
  }

  if (outputFormat == nsIPrintSettings::kOutputFormatPDF) {
    nsXPIDLString filename;
    mPrintSettings->GetToFileName(getter_Copies(filename));

    double width, height;
    mPrintSettings->GetEffectivePageSize(&width, &height);
    if (width <= 0 || height <= 0) {
      return NS_ERROR_FAILURE;
    }

    // convert twips to points
    width  /= TWIPS_PER_POINT_FLOAT;
    height /= TWIPS_PER_POINT_FLOAT;

    nsCOMPtr<nsIFile> file = do_CreateInstance("@mozilla.org/file/local;1");
    nsresult rv = file->InitWithPath(filename);
    if (NS_FAILED(rv))
      return rv;

    nsCOMPtr<nsIFileOutputStream> stream = do_CreateInstance("@mozilla.org/network/file-output-stream;1");
    rv = stream->Init(file, -1, -1, 0);
    if (NS_FAILED(rv))
      return rv;

    newSurface = new gfxPDFSurface(stream, gfxSize(width, height));
  } else {
    if (mDevMode) {
      NS_WARN_IF_FALSE(mDriverName, "No driver!");
      HDC dc = ::CreateDCW(mDriverName, mDeviceName, nullptr, mDevMode);
      if (!dc) {
        gfxCriticalError(gfxCriticalError::DefaultOptions(false)) << "Failed to create device context in GetSurfaceForPrinter";
        return NS_ERROR_GFX_PRINTER_NAME_NOT_FOUND;
      }

      // have this surface take over ownership of this DC
      newSurface = new gfxWindowsSurface(dc, gfxWindowsSurface::FLAG_TAKE_DC | gfxWindowsSurface::FLAG_FOR_PRINTING);
      if (newSurface->GetType() == (gfxSurfaceType)-1) {
        gfxCriticalError() << "Invalid windows surface from " << gfx::hexa(dc);
        return NS_ERROR_FAILURE;
      }
    }
  }

  newSurface.forget(surface);
  return NS_OK;
}

float
nsDeviceContextSpecWin::GetPrintingScale()
{
  MOZ_ASSERT(mPrintSettings);

  int32_t resolution;
  mPrintSettings->GetResolution(&resolution);
  return float(resolution) / GetDPI();
}

//----------------------------------------------------------------------------------
void nsDeviceContextSpecWin::SetDeviceName(char16ptr_t aDeviceName)
{
  CleanAndCopyString(mDeviceName, aDeviceName);
}

//----------------------------------------------------------------------------------
void nsDeviceContextSpecWin::SetDriverName(char16ptr_t aDriverName)
{
  CleanAndCopyString(mDriverName, aDriverName);
}

//----------------------------------------------------------------------------------
void nsDeviceContextSpecWin::SetDevMode(LPDEVMODEW aDevMode)
{
  if (mDevMode) {
    ::HeapFree(::GetProcessHeap(), 0, mDevMode);
  }

  mDevMode = aDevMode;
}

//------------------------------------------------------------------
void 
nsDeviceContextSpecWin::GetDevMode(LPDEVMODEW &aDevMode)
{
  aDevMode = mDevMode;
}

#define DISPLAY_LAST_ERROR 

//----------------------------------------------------------------------------------
// Setup the object's data member with the selected printer's data
nsresult
nsDeviceContextSpecWin::GetDataFromPrinter(char16ptr_t aName, nsIPrintSettings* aPS)
{
  nsresult rv = NS_ERROR_FAILURE;

  if (!GlobalPrinters::GetInstance()->PrintersAreAllocated()) {
    rv = GlobalPrinters::GetInstance()->EnumeratePrinterList();
    if (NS_FAILED(rv)) {
      PR_PL(("***** nsDeviceContextSpecWin::GetDataFromPrinter - Couldn't enumerate printers!\n"));
      DISPLAY_LAST_ERROR
    }
    NS_ENSURE_SUCCESS(rv, rv);
  }

  HANDLE hPrinter = nullptr;
  wchar_t *name = (wchar_t*)aName; // Windows APIs use non-const name argument
  
  BOOL status = ::OpenPrinterW(name, &hPrinter, nullptr);
  if (status) {

    LPDEVMODEW   pDevMode;
    DWORD       dwNeeded, dwRet;

    // Allocate a buffer of the correct size.
    dwNeeded = ::DocumentPropertiesW(nullptr, hPrinter, name, nullptr, nullptr, 0);

    pDevMode = (LPDEVMODEW)::HeapAlloc (::GetProcessHeap(), HEAP_ZERO_MEMORY, dwNeeded);
    if (!pDevMode) return NS_ERROR_FAILURE;

    // Get the default DevMode for the printer and modify it for our needs.
    dwRet = DocumentPropertiesW(nullptr, hPrinter, name,
                               pDevMode, nullptr, DM_OUT_BUFFER);

    if (dwRet == IDOK && aPS) {
      nsCOMPtr<nsIPrintSettingsWin> psWin = do_QueryInterface(aPS);
      MOZ_ASSERT(psWin);
      psWin->CopyToNative(pDevMode);
      // Sets back the changes we made to the DevMode into the Printer Driver
      dwRet = ::DocumentPropertiesW(nullptr, hPrinter, name,
                                   pDevMode, pDevMode,
                                   DM_IN_BUFFER | DM_OUT_BUFFER);
    }

    if (dwRet != IDOK) {
      ::HeapFree(::GetProcessHeap(), 0, pDevMode);
      ::ClosePrinter(hPrinter);
      PR_PL(("***** nsDeviceContextSpecWin::GetDataFromPrinter - DocumentProperties call failed code: %d/0x%x\n", dwRet, dwRet));
      DISPLAY_LAST_ERROR
      return NS_ERROR_FAILURE;
    }

    SetDevMode(pDevMode); // cache the pointer and takes responsibility for the memory

    SetDeviceName(aName);

    SetDriverName(kDriverName);

    ::ClosePrinter(hPrinter);
    rv = NS_OK;
  } else {
    rv = NS_ERROR_GFX_PRINTER_NAME_NOT_FOUND;
    PR_PL(("***** nsDeviceContextSpecWin::GetDataFromPrinter - Couldn't open printer: [%s]\n", NS_ConvertUTF16toUTF8(aName).get()));
    DISPLAY_LAST_ERROR
  }
  return rv;
}

//***********************************************************
//  Printer Enumerator
//***********************************************************
nsPrinterEnumeratorWin::nsPrinterEnumeratorWin()
{
}

nsPrinterEnumeratorWin::~nsPrinterEnumeratorWin()
{
  // Do not free printers here
  // GlobalPrinters::GetInstance()->FreeGlobalPrinters();
}

NS_IMPL_ISUPPORTS(nsPrinterEnumeratorWin, nsIPrinterEnumerator)

//----------------------------------------------------------------------------------
// Return the Default Printer name
NS_IMETHODIMP 
nsPrinterEnumeratorWin::GetDefaultPrinterName(char16_t * *aDefaultPrinterName)
{
  NS_ENSURE_ARG_POINTER(aDefaultPrinterName);

  *aDefaultPrinterName = GetDefaultPrinterNameFromGlobalPrinters(); // helper

  return NS_OK;
}

NS_IMETHODIMP 
nsPrinterEnumeratorWin::InitPrintSettingsFromPrinter(const char16_t *aPrinterName, nsIPrintSettings *aPrintSettings)
{
  NS_ENSURE_ARG_POINTER(aPrinterName);
  NS_ENSURE_ARG_POINTER(aPrintSettings);

  if (!*aPrinterName) {
    return NS_OK;
  }

  RefPtr<nsDeviceContextSpecWin> devSpecWin = new nsDeviceContextSpecWin();
  if (!devSpecWin) return NS_ERROR_OUT_OF_MEMORY;

  if (NS_FAILED(GlobalPrinters::GetInstance()->EnumeratePrinterList())) {
    return NS_ERROR_FAILURE;
  }

  AutoFreeGlobalPrinters autoFreeGlobalPrinters;

  devSpecWin->GetDataFromPrinter(aPrinterName);

  LPDEVMODEW devmode;
  devSpecWin->GetDevMode(devmode);
  if (NS_WARN_IF(!devmode)) {
    return NS_ERROR_FAILURE;
  }

  aPrintSettings->SetPrinterName(aPrinterName);

  // We need to get information from the device as well.
  HDC dc = ::CreateICW(kDriverName, aPrinterName, nullptr, devmode);
  if (NS_WARN_IF(!dc)) {
    return NS_ERROR_FAILURE;
  }

  nsCOMPtr<nsIPrintSettingsWin> psWin = do_QueryInterface(aPrintSettings);
  MOZ_ASSERT(psWin);
  psWin->CopyFromNative(dc, devmode);
  ::DeleteDC(dc);

  return NS_OK;
}


//----------------------------------------------------------------------------------
// Enumerate all the Printers from the global array and pass their
// names back (usually to script)
NS_IMETHODIMP 
nsPrinterEnumeratorWin::GetPrinterNameList(nsIStringEnumerator **aPrinterNameList)
{
  NS_ENSURE_ARG_POINTER(aPrinterNameList);
  *aPrinterNameList = nullptr;

  nsresult rv = GlobalPrinters::GetInstance()->EnumeratePrinterList();
  if (NS_FAILED(rv)) {
    PR_PL(("***** nsDeviceContextSpecWin::GetPrinterNameList - Couldn't enumerate printers!\n"));
    return rv;
  }

  uint32_t numPrinters = GlobalPrinters::GetInstance()->GetNumPrinters();
  nsTArray<nsString> *printers = new nsTArray<nsString>(numPrinters);
  if (!printers)
    return NS_ERROR_OUT_OF_MEMORY;

  uint32_t printerInx = 0;
  nsString* names = printers->AppendElements(numPrinters);
  while( printerInx < numPrinters ) {
    LPWSTR name = GlobalPrinters::GetInstance()->GetItemFromList(printerInx++);
    names[printerInx].Assign(name);
  }

  return NS_NewAdoptingStringEnumerator(aPrinterNameList, printers);
}

//----------------------------------------------------------------------------------
// Display the AdvancedDocumentProperties for the selected Printer
NS_IMETHODIMP nsPrinterEnumeratorWin::DisplayPropertiesDlg(const char16_t *aPrinterName, nsIPrintSettings* aPrintSettings)
{
  // Implementation removed because it is unused
  return NS_OK;
}

//----------------------------------------------------------------------------------
//-- Global Printers
//----------------------------------------------------------------------------------

//----------------------------------------------------------------------------------
// THe array hold the name and port for each printer
void 
GlobalPrinters::ReallocatePrinters()
{
  if (PrintersAreAllocated()) {
    FreeGlobalPrinters();
  }
  mPrinters = new nsTArray<LPWSTR>();
  NS_ASSERTION(mPrinters, "Printers Array is NULL!");
}

//----------------------------------------------------------------------------------
void 
GlobalPrinters::FreeGlobalPrinters()
{
  if (mPrinters != nullptr) {
    for (uint32_t i=0;i<mPrinters->Length();i++) {
      free(mPrinters->ElementAt(i));
    }
    delete mPrinters;
    mPrinters = nullptr;
  }
}

//----------------------------------------------------------------------------------
nsresult 
GlobalPrinters::EnumerateNativePrinters()
{
  nsresult rv = NS_ERROR_GFX_PRINTER_NO_PRINTER_AVAILABLE;
  PR_PL(("-----------------------\n"));
  PR_PL(("EnumerateNativePrinters\n"));

  WCHAR szDefaultPrinterName[1024];    
  DWORD status = GetProfileStringW(L"devices", 0, L",",
                                   szDefaultPrinterName,
                                   ArrayLength(szDefaultPrinterName));
  if (status > 0) {
    DWORD count = 0;
    LPWSTR sPtr   = szDefaultPrinterName;
    LPWSTR ePtr   = szDefaultPrinterName + status;
    LPWSTR prvPtr = sPtr;
    while (sPtr < ePtr) {
      if (*sPtr == 0) {
        LPWSTR name = wcsdup(prvPtr);
        mPrinters->AppendElement(name);
        PR_PL(("Printer Name:    %s\n", prvPtr));
        prvPtr = sPtr+1;
        count++;
      }
      sPtr++;
    }
    rv = NS_OK;
  }
  PR_PL(("-----------------------\n"));
  return rv;
}

//------------------------------------------------------------------
// Uses the GetProfileString to get the default printer from the registry
void 
GlobalPrinters::GetDefaultPrinterName(nsString& aDefaultPrinterName)
{
  aDefaultPrinterName.Truncate();
  WCHAR szDefaultPrinterName[1024];    
  DWORD status = GetProfileStringW(L"windows", L"device", 0,
                                   szDefaultPrinterName,
                                   ArrayLength(szDefaultPrinterName));
  if (status > 0) {
    WCHAR comma = ',';
    LPWSTR sPtr = szDefaultPrinterName;
    while (*sPtr != comma && *sPtr != 0) 
      sPtr++;
    if (*sPtr == comma) {
      *sPtr = 0;
    }
    aDefaultPrinterName = szDefaultPrinterName;
  } else {
    aDefaultPrinterName = EmptyString();
  }

  PR_PL(("DEFAULT PRINTER [%s]\n", aDefaultPrinterName.get()));
}

//----------------------------------------------------------------------------------
// This goes and gets the list of available printers and puts
// the default printer at the beginning of the list
nsresult 
GlobalPrinters::EnumeratePrinterList()
{
  // reallocate and get a new list each time it is asked for
  // this deletes the list and re-allocates them
  ReallocatePrinters();

  // any of these could only fail with an OUT_MEMORY_ERROR
  // PRINTER_ENUM_LOCAL should get the network printers on Win95
  nsresult rv = EnumerateNativePrinters();
  if (NS_FAILED(rv)) return rv;

  // get the name of the default printer
  nsAutoString defPrinterName;
  GetDefaultPrinterName(defPrinterName);

  // put the default printer at the beginning of list
  if (!defPrinterName.IsEmpty()) {
    for (uint32_t i=0;i<mPrinters->Length();i++) {
      LPWSTR name = mPrinters->ElementAt(i);
      if (defPrinterName.Equals(name)) {
        if (i > 0) {
          LPWSTR ptr = mPrinters->ElementAt(0);
          mPrinters->ElementAt(0) = name;
          mPrinters->ElementAt(i) = ptr;
        }
        break;
      }
    }
  }

  // make sure we at least tried to get the printers
  if (!PrintersAreAllocated()) {
    PR_PL(("***** nsDeviceContextSpecWin::EnumeratePrinterList - Printers aren`t allocated\n"));
    return NS_ERROR_FAILURE;
  }

  return NS_OK;
}

